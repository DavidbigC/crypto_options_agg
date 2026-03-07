/**
 * Bybit WebSocket client for options tickers.
 * Subscribes to tickers.{symbol} for all BTC/ETH/SOL options.
 * Cache shape matches the REST bybitTickerCache so buildBybitResponse needs no changes.
 */

import { WebSocket } from 'ws'

const WS_URL = 'wss://stream.bybit.com/v5/public/option'
const COINS = ['BTC', 'ETH', 'SOL']
const BYBIT_REST = 'https://api.bybit.com/v5'
const HEARTBEAT_MS = 20_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
const INSTRUMENT_REFRESH_MS = 10 * 60 * 1000  // 10 minutes
const CHUNK = 500  // args per subscribe message

// Coin-keyed symbol cache: { BTC: { [symbol]: ticker }, ETH: {...}, SOL: {...} }
// Keyed by coin so per-message updates are O(1) — no array rebuild on every tick
export const bybitWsTickerCache = { BTC: {}, ETH: {}, SOL: {} }

// Spot price cache: { BTC: 0, ETH: 0, SOL: 0 } — populated from indexPrice in ticker msgs
export const bybitWsSpotCache = { BTC: 0, ETH: 0, SOL: 0 }

let _updateCallback = null
export function setBybitWsUpdateCallback(fn) { _updateCallback = fn }

async function fetchInstruments(coin) {
  const symbols = []
  let cursor = ''
  try {
    do {
      const url = `${BYBIT_REST}/market/instruments-info?category=option&baseCoin=${coin}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await fetch(url, { headers: { 'User-Agent': 'bybit-options-viewer/1.0' } })
      const json = await res.json()
      for (const i of json.result?.list ?? []) symbols.push(i.symbol)
      cursor = json.result?.nextPageCursor ?? ''
    } while (cursor)
  } catch (err) {
    console.error(`Bybit WS: instrument fetch error (${coin}):`, err.message)
  }
  return symbols
}

async function fetchAllInstruments() {
  const results = await Promise.all(COINS.map(fetchInstruments))
  const all = []
  COINS.forEach((coin, i) => {
    results[i].forEach(symbol => all.push({ coin, symbol }))
  })
  return all
}

// Normalize WS ticker fields to match REST field names used in buildBybitResponse.
// Only includes fields that are actually present in the message (critical for delta updates).
function normalize(data) {
  const out = {}
  if (data.symbol            !== undefined) out.symbol            = data.symbol
  if (data.bidPrice          !== undefined) out.bid1Price         = data.bidPrice
  if (data.askPrice          !== undefined) out.ask1Price         = data.askPrice
  if (data.lastPrice         !== undefined) out.lastPrice         = data.lastPrice
  if (data.volume24h         !== undefined) out.volume24h         = data.volume24h
  if (data.bidSize           !== undefined) out.bid1Size          = data.bidSize
  if (data.askSize           !== undefined) out.ask1Size          = data.askSize
  if (data.delta             !== undefined) out.delta             = data.delta
  if (data.gamma             !== undefined) out.gamma             = data.gamma
  if (data.theta             !== undefined) out.theta             = data.theta
  if (data.vega              !== undefined) out.vega              = data.vega
  if (data.markPriceIv       !== undefined) out.impliedVolatility = data.markPriceIv
  if (data.openInterest      !== undefined) out.openInterest      = data.openInterest
  if (data.markPrice         !== undefined) out.markPrice         = data.markPrice
  if (data.underlyingPrice   !== undefined) out.underlyingPrice   = data.underlyingPrice
  return out
}

async function warmCache() {
  console.log('Bybit WS: warming cache from REST...')
  await Promise.all(COINS.map(async (coin) => {
    try {
      const url = `${BYBIT_REST}/market/tickers?category=option&baseCoin=${coin}`
      const res = await fetch(url, { headers: { 'User-Agent': 'bybit-options-viewer/1.0' } })
      const json = await res.json()
      const list = json.result?.list ?? []
      let spotSet = false
      for (const t of list) {
        bybitWsTickerCache[coin][t.symbol] = {
          symbol:            t.symbol,
          bid1Price:         t.bid1Price        ?? '0',
          ask1Price:         t.ask1Price        ?? '0',
          lastPrice:         t.lastPrice        ?? '0',
          volume24h:         t.volume24h        ?? '0',
          bid1Size:          t.bid1Size         ?? '0',
          ask1Size:          t.ask1Size         ?? '0',
          delta:             t.delta            ?? '0',
          gamma:             t.gamma            ?? '0',
          theta:             t.theta            ?? '0',
          vega:              t.vega             ?? '0',
          impliedVolatility: t.markIv           ?? '0',
          openInterest:      t.openInterest     ?? '0',
          markPrice:         t.markPrice        ?? '0',
          underlyingPrice:   t.underlyingPrice  ?? '0',
        }
        if (!spotSet) {
          const spot = parseFloat(t.indexPrice)
          if (spot > 0) { bybitWsSpotCache[coin] = spot; spotSet = true }
        }
      }
      console.log(`Bybit WS: warm cache ${coin} — ${list.length} tickers`)
      if (_updateCallback) _updateCallback(coin)
    } catch (err) {
      console.error(`Bybit WS: warm cache error (${coin}):`, err.message)
    }
  }))
}

export function startBybitWS() {
  let reconnectDelay = RECONNECT_BASE_MS
  let ws = null
  let instruments = []  // [{ coin, symbol }]
  let heartbeatTimer = null
  let refreshTimer = null

  warmCache()

  async function connect() {
    console.log('Bybit WS: fetching instruments...')
    instruments = await fetchAllInstruments()
    console.log(`Bybit WS: fetched ${instruments.length} instruments across ${COINS.join('/')}`)

    const validSymbols = new Set(instruments.map(i => i.symbol))
    for (const coin of COINS) {
      for (const sym of Object.keys(bybitWsTickerCache[coin])) {
        if (!validSymbols.has(sym)) delete bybitWsTickerCache[coin][sym]
      }
    }

    console.log('Bybit WS: connecting...')
    ws = new WebSocket(WS_URL)

    ws.on('open', () => {
      console.log('Bybit WS: connected')
      reconnectDelay = RECONNECT_BASE_MS

      // Subscribe in chunks
      const args = instruments.map(i => `tickers.${i.symbol}`)
      for (let i = 0; i < args.length; i += CHUNK) {
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: args.slice(i, i + CHUNK),
        }))
      }
      console.log(`Bybit WS: subscribed to ${args.length} ticker channels`)

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ req_id: 'hb', op: 'ping' }))
        }
      }, HEARTBEAT_MS)

      // Periodically re-fetch instruments and subscribe to new ones
      refreshTimer = setInterval(async () => {
        const fresh = await fetchAllInstruments()
        const existing = new Set(instruments.map(i => i.symbol))
        const newOnes = fresh.filter(i => !existing.has(i.symbol))
        instruments = fresh
        if (newOnes.length > 0 && ws.readyState === WebSocket.OPEN) {
          const newArgs = newOnes.map(i => `tickers.${i.symbol}`)
          for (let i = 0; i < newArgs.length; i += CHUNK) {
            ws.send(JSON.stringify({ op: 'subscribe', args: newArgs.slice(i, i + CHUNK) }))
          }
          console.log(`Bybit WS: subscribed to ${newOnes.length} new instruments`)
        }
      }, INSTRUMENT_REFRESH_MS)
    })

    // Diagnostic counters — log message rate every 10s
    const msgCount = { BTC: 0, ETH: 0, SOL: 0 }
    const diagTimer = setInterval(() => {
      console.log(`Bybit WS msgs/10s — BTC:${msgCount.BTC} ETH:${msgCount.ETH} SOL:${msgCount.SOL}`)
      msgCount.BTC = 0; msgCount.ETH = 0; msgCount.SOL = 0
    }, 10_000)

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      // Ignore pong and subscription confirmations
      if (msg.op === 'pong') return
      if (msg.op === 'subscribe') return

      if (msg.topic?.startsWith('tickers.') && msg.data) {
        const coin = msg.data.symbol?.split('-')[0]
        if (!coin || !bybitWsTickerCache[coin]) return

        if (msgCount[coin] !== undefined) msgCount[coin]++

        // Merge delta fields into existing entry — Bybit sends partial updates where
        // only changed fields are included; replacing would zero out unchanged fields.
        const prev = bybitWsTickerCache[coin][msg.data.symbol] ?? {}
        bybitWsTickerCache[coin][msg.data.symbol] = { ...prev, ...normalize(msg.data) }

        // Update spot from indexPrice (consistent across all expiries)
        const spot = parseFloat(msg.data.indexPrice)
        if (spot > 0) bybitWsSpotCache[coin] = spot

        if (_updateCallback) _updateCallback(coin)
      }
    })

    ws.on('close', () => { clearInterval(diagTimer) })

    ws.on('close', () => {
      clearInterval(heartbeatTimer)
      clearInterval(refreshTimer)
      console.log(`Bybit WS: closed, reconnecting in ${reconnectDelay}ms`)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    ws.on('error', (err) => {
      console.error('Bybit WS error:', err.message)
      ws.terminate()
    })
  }

  connect()
}
