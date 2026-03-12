/**
 * Binance eapi WebSocket client
 * Subscribes to btcusdt@optionMarkPrice and ethusdt@optionMarkPrice.
 * Each message delivers all contracts for one underlying with Greeks + bid/ask.
 * Prices are in USDT. No separate REST poll needed.
 */

import { WebSocket } from 'ws'

const WS_URL = 'wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice/ethusdt@optionMarkPrice/solusdt@optionMarkPrice'
const HEARTBEAT_MS = 3 * 60_000   // send ping every 3min (server pings every 5min)
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS  = 60_000

// Cache keyed by symbol: { 'BTC-250328-80000-C': { bo, ao, bq, aq, d, g, t, v, vo, b, a, mp, i } }
export const binanceCache = {
  BTC: {},
  ETH: {},
  SOL: {},
}

// Latest index price per coin
export const binanceSpotCache = {
  BTC: 0,
  ETH: 0,
  SOL: 0,
}

let _updateCallback = null
export function setBinanceUpdateCallback(fn) { _updateCallback = fn }

export function startBinanceWS() {
  let reconnectDelay = RECONNECT_BASE_MS

  function connect() {
    console.log('Binance WS: connecting...')
    const ws = new WebSocket(WS_URL)
    let heartbeatTimer = null

    ws.on('open', () => {
      console.log('Binance WS: connected')
      reconnectDelay = RECONNECT_BASE_MS

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      }, HEARTBEAT_MS)
    })

    // Respond to server pings with pong (ws library does this automatically,
    // but explicit handling ensures compatibility)
    ws.on('ping', () => {
      if (ws.readyState === WebSocket.OPEN) ws.pong()
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // Combined stream wraps payload: { stream, data: [...] }
      const items = msg.data
      if (!Array.isArray(items) || items.length === 0) return

      // Determine coin from stream name: 'btcusdt@optionMarkPrice' → 'BTC'
      const stream = msg.stream ?? ''
      const coin = stream.startsWith('btc') ? 'BTC' : stream.startsWith('eth') ? 'ETH' : stream.startsWith('sol') ? 'SOL' : null
      if (!coin || !binanceCache[coin]) return

      for (const item of items) {
        const sym = item.s
        if (!sym) continue
        binanceCache[coin][sym] = item
        // Keep spot updated from index price on every item
        const idx = parseFloat(item.i ?? 0)
        if (idx > 0) binanceSpotCache[coin] = idx
      }

      if (_updateCallback) _updateCallback(coin)
    })

    ws.on('close', () => {
      clearInterval(heartbeatTimer)
      console.log(`Binance WS: closed, reconnecting in ${reconnectDelay}ms`)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    ws.on('error', (err) => {
      console.error('Binance WS error:', err.message)
      ws.terminate()
    })
  }

  connect()
}
