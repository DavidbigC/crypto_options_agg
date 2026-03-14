/**
 * Deribit WebSocket client
 * Subscribes to ticker.{instrument_name}.100ms for all BTC/ETH/SOL options.
 * Stores greeks (delta, gamma, theta, vega) keyed by instrument_name.
 * Greeks are in USD for all coins (Deribit normalises internally).
 */

import { WebSocket } from 'ws'

const WS_URL = 'wss://www.deribit.com/ws/api/v2'
const DERIBIT_REST = 'https://www.deribit.com/api/v2'
// Maps logical currency → { apiCurrency, prefix }
// SOL options are USDC-settled: listed under currency=USDC with SOL_USDC- prefix
const CURRENCIES = [
  { key: 'BTC',      apiCurrency: 'BTC',  prefix: null       },
  { key: 'ETH',      apiCurrency: 'ETH',  prefix: null       },
  { key: 'SOL_USDC', apiCurrency: 'USDC', prefix: 'SOL_USDC' },
]
const HEARTBEAT_MS = 25_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000
const CHUNK = 200  // channels per subscribe message

function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id))
}

// Keyed by instrument_name: { delta, gamma, theta, vega, rho, bid_iv, ask_iv }
export const deribitGreeksCache = {}

let _updateCallback = null
export function setDeribitUpdateCallback(fn) { _updateCallback = fn }

async function fetchInstruments({ apiCurrency, prefix }) {
  const url = `${DERIBIT_REST}/public/get_instruments?currency=${apiCurrency}&kind=option&expired=false`
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'deribit-options-viewer/1.0' } })
  const json = await res.json()
  const all = json.result?.map(i => i.instrument_name) ?? []
  return prefix ? all.filter(name => name.startsWith(prefix)) : all
}

export function startDeribitWS() {
  let reconnectDelay = RECONNECT_BASE_MS

  function connect() {
    console.log('Deribit WS: connecting...')
    const ws = new WebSocket(WS_URL)
    let heartbeatTimer = null

    ws.on('open', async () => {
      console.log('Deribit WS: connected')
      reconnectDelay = RECONNECT_BASE_MS

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'public/test', id: 'hb' }))
        }
      }, HEARTBEAT_MS)

      const allInstruments = []
      for (const cur of CURRENCIES) {
        try {
          const instruments = await fetchInstruments(cur)
          allInstruments.push(...instruments)
        } catch (err) {
          console.error(`Deribit WS: failed to fetch ${cur.key} instruments:`, err.message)
        }
      }

      if (allInstruments.length === 0) {
        console.error('Deribit WS: no instruments fetched, will retry on reconnect')
        return
      }

      const channels = allInstruments.map(i => `ticker.${i}.100ms`)
      for (let i = 0; i < channels.length; i += CHUNK) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'public/subscribe',
          params: { channels: channels.slice(i, i + CHUNK) },
          id: `sub-${i}`,
        }))
      }
      console.log(`Deribit WS: subscribed to ${channels.length} ticker channels`)
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }

      if (msg.method !== 'subscription') return
      const { channel, data } = msg.params ?? {}
      if (!channel?.startsWith('ticker.') || !data?.greeks) return

      const instrument = channel.split('.')[1]
      deribitGreeksCache[instrument] = {
        ...data.greeks,
        bid_iv: data.bid_iv,
        ask_iv: data.ask_iv,
      }
      if (_updateCallback) {
        const rawCurrency = instrument.split('-')[0]
        _updateCallback(rawCurrency === 'SOL_USDC' ? 'SOL' : rawCurrency)
      }
    })

    ws.on('close', () => {
      clearInterval(heartbeatTimer)
      console.log(`Deribit WS: closed, reconnecting in ${reconnectDelay}ms`)
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    ws.on('error', (err) => {
      console.error('Deribit WS error:', err.message)
      ws.terminate()
    })
  }

  connect()
}
