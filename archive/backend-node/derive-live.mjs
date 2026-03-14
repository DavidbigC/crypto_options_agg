/**
 * Live ticker_slim monitor for one expiry.
 * Prints each push as it arrives so you can compare with Lyra's frontend.
 * Run: node derive-live.mjs [EXPIRY e.g. 20260307]
 */
import { WebSocket } from 'ws'

const EXPIRY = process.argv[2] ?? '20260307'
const COIN   = 'BTC'

// Get instrument names for this expiry
const r = await fetch('https://api.lyra.finance/public/get_all_instruments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expired: false, instrument_type: 'option', currency: COIN, page_size: 1000 }),
})
const names = ((await r.json()).result?.instruments ?? [])
  .map(i => i.instrument_name)
  .filter(n => n.startsWith(`${COIN}-${EXPIRY}-`))

console.log(`Subscribing to ${names.length} instruments for ${COIN}-${EXPIRY}`)
console.log('Printing each push as it arrives...\n')

const ws = new WebSocket('wss://api.lyra.finance/ws')
let pushCount = 0
const t0 = Date.now()

ws.on('open', () => {
  const channels = names.map(n => `ticker_slim.${n}.100`)
  for (let i = 0; i < channels.length; i += 200) {
    ws.send(JSON.stringify({ method: 'subscribe', params: { channels: channels.slice(i, i+200) }, id: i }))
  }
})

ws.on('message', raw => {
  const msg = JSON.parse(raw)
  if (msg.method !== 'subscription') return
  const { channel, data } = msg.params ?? {}
  if (!channel?.startsWith('ticker_slim.') || !data?.instrument_ticker) return

  const name = channel.split('.').slice(1, -1).join('.')
  const t = data.instrument_ticker
  const p = t.option_pricing ?? {}
  pushCount++

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const iv = p.i ? (parseFloat(p.i) * 100).toFixed(1) + '%' : '--'
  console.log(`[${elapsed}s #${pushCount}] ${name.padEnd(28)} bid=${String(t.b).padStart(6)}  ask=${String(t.a).padStart(6)}  IV=${iv}`)
})

ws.on('error', err => console.error('WS error:', err.message))

// Print summary every 10s
setInterval(() => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
  console.log(`\n--- ${elapsed}s elapsed, total pushes: ${pushCount} (${(pushCount / +elapsed).toFixed(1)}/s) ---\n`)
}, 10000)
