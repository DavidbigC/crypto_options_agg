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

// Cache shape identical to REST bybitTickerCache: { BTC: [...tickers], ETH: [...], SOL: [...] }
export const bybitWsTickerCache = { BTC: [], ETH: [], SOL: [] }

// Spot price cache: { BTC: 0, ETH: 0, SOL: 0 } — populated from underlyingPrice in ticker msgs
export const bybitWsSpotCache = { BTC: 0, ETH: 0, SOL: 0 }

// Per-symbol ticker store for fast updates: { [symbol]: normalizedTicker }
const symbolCache = {}

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

// Normalize WS ticker fields to match REST field names used in buildBybitResponse
function normalize(data) {
  return {
    symbol:            data.symbol,
    bid1Price:         data.bidPrice  ?? '0',
    ask1Price:         data.askPrice  ?? '0',
    lastPrice:         data.lastPrice ?? '0',
    volume24h:         data.volume24h ?? '0',
    bid1Size:          data.bidSize   ?? '0',
    ask1Size:          data.askSize   ?? '0',
    delta:             data.delta     ?? '0',
    gamma:             data.gamma     ?? '0',
    theta:             data.theta     ?? '0',
    vega:              data.vega      ?? '0',
    impliedVolatility: data.markPriceIv ?? '0',
    openInterest:      data.openInterest ?? '0',
    markPrice:         data.markPrice ?? '0',
    underlyingPrice:   data.underlyingPrice ?? '0',
  }
}

export function startBybitWS() {
  let reconnectDelay = RECONNECT_BASE_MS
  let ws = null
  let instruments = []  // [{ coin, symbol }]
  let heartbeatTimer = null
  let refreshTimer = null

  async function connect() {
    console.log('Bybit WS: fetching instruments...')
    instruments = await fetchAllInstruments()
    console.log(`Bybit WS: fetched ${instruments.length} instruments across ${COINS.join('/')}`)

    const validSymbols = new Set(instruments.map(i => i.symbol))
    for (const sym of Object.keys(symbolCache)) {
      if (!validSymbols.has(sym)) delete symbolCache[sym]
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

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      // Ignore pong and subscription confirmations
      if (msg.op === 'pong') return
      if (msg.op === 'subscribe') return

      if (msg.topic?.startsWith('tickers.') && msg.data) {
        const ticker = normalize(msg.data)
        symbolCache[ticker.symbol] = ticker

        // Update spot cache from indexPrice (true spot index, consistent across all expiries)
        // underlyingPrice varies per expiry due to futures basis — do not use for spot
        const coin = ticker.symbol.split('-')[0]
        const spot = parseFloat(msg.data.indexPrice)
        if (spot > 0 && bybitWsSpotCache[coin] !== undefined) {
          bybitWsSpotCache[coin] = spot
        }

        // Rebuild the array cache for this coin and notify
        bybitWsTickerCache[coin] = Object.values(symbolCache).filter(t => t.symbol.startsWith(`${coin}-`))

        if (_updateCallback) _updateCallback(coin)
      }
    })

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
