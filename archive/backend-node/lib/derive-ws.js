/**
 * Derive WebSocket client — demand-driven
 * Opens WS when the first SSE viewer connects, closes when the last leaves.
 * Instrument names + ticker cache are kept warm in memory so reconnects are
 * fast (~300ms) instead of requiring a full bootstrap (3-6s).
 *
 * ticker_slim abbreviated fields:
 *   b=bid, a=ask, f=last, B=bid_size, A=ask_size, I=index, M=mark
 *   option_pricing: d=delta, g=gamma, t=theta, v=vega, i=IV, m=mark_price
 *   stats: v=volume, oi=open_interest
 */

import { WebSocket } from 'ws'

const WS_URL         = 'wss://api.lyra.finance/ws'
const DERIVE_REST    = 'https://api.lyra.finance'
const CHUNK          = 200
const FAST_EXPIRIES  = 4
const HEARTBEAT_MS   = 25_000
const RECONNECT_BASE = 2_000
const RECONNECT_MAX  = 60_000
const SUPPORTED_CURRENCIES = ['BTC', 'ETH']

function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id))
}

// Keyed by instrument_name → raw ticker_slim instrument_ticker object (kept warm)
export const deriveTickersCache = {}

// Keyed by currency → spot price number (kept warm)
export const deriveSpotCache = {}

let _updateCallback = null
export function setDeriveUpdateCallback(fn) { _updateCallback = fn }

let _webSocketFactory = (url) => new WebSocket(url)

// ─── Module state ─────────────────────────────────────────────────────────────

const viewerCounts     = {}  // { BTC: 2, ETH: 0 } — ref count per currency
const instrumentsCache = {}  // { BTC: [...names] } — kept warm, never cleared

let _ws               = null
let _intentionalClose = false
let _reconnectDelay   = RECONNECT_BASE

function _totalViewers() {
  return Object.values(viewerCounts).reduce((s, n) => s + n, 0)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function addDeriveViewer(currency) {
  viewerCounts[currency] = (viewerCounts[currency] ?? 0) + 1
  console.log(`Derive: viewer+ ${currency} (now ${viewerCounts[currency]})`)

  if (_totalViewers() === 1) {
    // First viewer of any currency — open WS
    _intentionalClose = false
    _connect()
  } else if (_ws?.readyState === WebSocket.OPEN) {
    // WS already open — subscribe this currency immediately
    _subscribeForCurrency(currency).catch(err =>
      console.error(`Derive subscribe error (${currency}):`, err.message)
    )
  }
  // If WS is mid-connect, ws.on('open') will subscribe all active currencies
}

export function startDeriveFeed() {
  if (_ws) return
  _intentionalClose = false
  _connect()
}

export function removeDeriveViewer(currency) {
  viewerCounts[currency] = Math.max(0, (viewerCounts[currency] ?? 0) - 1)
  console.log(`Derive: viewer- ${currency} (now ${viewerCounts[currency]})`)
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _connect() {
  console.log('Derive WS: connecting…')
  _ws = _webSocketFactory(WS_URL)
  let heartbeatTimer = null

  _ws.on('open', async () => {
    console.log('Derive WS: connected')
    _reconnectDelay = RECONNECT_BASE

    heartbeatTimer = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN)
        _ws.send(JSON.stringify({ method: 'public/heartbeat', params: {}, id: 'hb' }))
    }, HEARTBEAT_MS)

    for (const currency of SUPPORTED_CURRENCIES) {
      try { await _subscribeForCurrency(currency) }
      catch (err) { console.error(`Derive WS subscribe error (${currency}):`, err.message) }
    }
  })

  _ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.method !== 'subscription') return

    const { channel, data } = msg.params ?? {}
    if (!channel || !data) return

    if (channel.startsWith('ticker_slim.') && data.instrument_ticker) {
      const parts      = channel.split('.')
      const instrument = parts.slice(1, -1).join('.')
      deriveTickersCache[instrument] = data.instrument_ticker

      const currency   = instrument.split('-')[0]
      const indexPrice = parseFloat(data.instrument_ticker.I ?? 0)
      if (indexPrice > 0) deriveSpotCache[currency] = indexPrice
      if (_updateCallback) _updateCallback(currency)
    }
  })

  _ws.on('close', () => {
    clearInterval(heartbeatTimer)
    _ws = null
    if (_intentionalClose) {
      console.log('Derive WS: closed (intentional)')
      return
    }
    console.log(`Derive WS: closed unexpectedly, reconnecting in ${_reconnectDelay}ms`)
    setTimeout(_connect, _reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX)
  })

  _ws.on('error', (err) => {
    console.error('Derive WS error:', err.message)
    _ws?.terminate()
  })
}

export function __setDeriveWebSocketFactoryForTests(factory) {
  _webSocketFactory = factory
}

export function __resetDeriveStateForTests() {
  _intentionalClose = true
  _ws?.terminate?.()
  _ws = null
  _intentionalClose = false
  _reconnectDelay = RECONNECT_BASE
  _updateCallback = null
  _webSocketFactory = (url) => new WebSocket(url)
  for (const key of Object.keys(viewerCounts)) delete viewerCounts[key]
  for (const key of Object.keys(instrumentsCache)) delete instrumentsCache[key]
  for (const key of Object.keys(deriveTickersCache)) delete deriveTickersCache[key]
  for (const key of Object.keys(deriveSpotCache)) delete deriveSpotCache[key]
}

async function _subscribeForCurrency(currency) {
  // Fetch + cache instrument names if not already done
  if (!instrumentsCache[currency]) {
    const res  = await fetchWithTimeout(`${DERIVE_REST}/public/get_all_instruments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'options-viewer/1.0' },
      body: JSON.stringify({ expired: false, instrument_type: 'option', currency, page_size: 1000 }),
    })
    const json = await res.json()
    instrumentsCache[currency] = (json.result?.instruments ?? []).map(i => i.instrument_name).filter(Boolean)
  }

  const names = instrumentsCache[currency]

  // Bootstrap REST data only if ticker cache is cold for this currency
  const cacheHit = Object.keys(deriveTickersCache).some(k => k.startsWith(`${currency}-`))
  if (!cacheHit) {
    _bootstrapSpot(currency)
    await _bootstrapTickers(currency, names)
  }

  // Build tiered channel list and subscribe
  const expiries  = [...new Set(names.map(n => n.split('-')[1]).filter(Boolean))].sort()
  const fastSet   = new Set(expiries.slice(0, FAST_EXPIRIES))
  const fastNames = names.filter(n =>  fastSet.has(n.split('-')[1]))
  const slowNames = names.filter(n => !fastSet.has(n.split('-')[1]))

  const allChannels = [
    ...fastNames.map(n => `ticker_slim.${n}.100`),
    ...slowNames.map(n => `ticker_slim.${n}.1000`),
  ]

  if (!_ws || _ws.readyState !== WebSocket.OPEN) return

  for (let i = 0; i < allChannels.length; i += CHUNK) {
    _ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channels: allChannels.slice(i, i + CHUNK) },
      id: `sub-${currency}-${i}`,
    }))
  }
  console.log(`Derive WS: subscribed ${currency} — ${fastNames.length} fast (100ms) + ${slowNames.length} slow (1000ms)`)
}

function _unsubscribeForCurrency(currency) {
  const names = instrumentsCache[currency]
  if (!names || !_ws || _ws.readyState !== WebSocket.OPEN) return

  // Unsubscribe both interval variants to be safe
  const allChannels = [
    ...names.map(n => `ticker_slim.${n}.100`),
    ...names.map(n => `ticker_slim.${n}.1000`),
  ]

  for (let i = 0; i < allChannels.length; i += CHUNK) {
    _ws.send(JSON.stringify({
      method: 'unsubscribe',
      params: { channels: allChannels.slice(i, i + CHUNK) },
      id: `unsub-${currency}-${i}`,
    }))
  }
  console.log(`Derive WS: unsubscribed ${currency}`)
}

async function _bootstrapTickers(currency, names) {
  const expirySet = new Set()
  for (const name of names) {
    const parts = name.split('-')
    if (parts.length >= 4 && /^\d{8}$/.test(parts[1])) expirySet.add(parts[1])
  }
  for (const expiryDate of expirySet) {
    try {
      const res  = await fetchWithTimeout(`${DERIVE_REST}/public/get_tickers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'options-viewer/1.0' },
        body: JSON.stringify({ instrument_type: 'option', currency, expiry_date: expiryDate }),
      })
      const json = await res.json()
      for (const [name, data] of Object.entries(json.result?.tickers ?? {})) {
        deriveTickersCache[name] = data
      }
    } catch (err) {
      console.error(`Derive bootstrap error (${currency} ${expiryDate}):`, err.message)
    }
  }
  console.log(`Derive bootstrap done (${currency}): ${Object.keys(deriveTickersCache).filter(k => k.startsWith(`${currency}-`)).length} instruments cached`)
}

async function _bootstrapSpot(currency) {
  try {
    const res  = await fetchWithTimeout(`${DERIVE_REST}/public/get_ticker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'options-viewer/1.0' },
      body: JSON.stringify({ instrument_name: `${currency}-PERP` }),
    })
    const json = await res.json()
    const price = parseFloat(json.result?.index_price ?? json.result?.mark_price ?? 0)
    if (price > 0) deriveSpotCache[currency] = price
  } catch (err) {
    console.error(`Derive spot bootstrap error (${currency}):`, err.message)
  }
}
