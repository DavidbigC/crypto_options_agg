/**
 * Derive raw output test — uses public/get_tickers over WS (same as production)
 * Tries to fetch all tickers without expiry_date first; falls back to per-expiry.
 * Run: node derive-test.mjs [BTC|ETH] [N_strikes]
 */
import { WebSocket } from 'ws'

const COIN      = process.argv[2]?.toUpperCase() ?? 'BTC'
const N_STRIKES = parseInt(process.argv[3] ?? '5')
const WS_URL    = 'wss://api.lyra.finance/ws'
const TIMEOUT   = 30_000

let reqId = 1
function send(ws, method, params = {}) {
  const id = reqId++
  ws.send(JSON.stringify({ method, params, id }))
  return id
}

async function wsRequest(method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.on('open', () => {
      const id = send(ws, method, params)
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw) } catch { return }
        if (msg.id !== id) return
        ws.close()
        resolve(msg.result)
      })
    })
    ws.on('error', reject)
    setTimeout(() => { ws.close(); reject(new Error('WS timeout')) }, TIMEOUT)
  })
}

// 1. Fetch instrument list via REST (fast) to discover expiry dates
console.log(`Fetching ${COIN} instruments via REST…`)
const instrResp = await fetch('https://api.lyra.finance/public/get_all_instruments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expired: false, instrument_type: 'option', currency: COIN, page_size: 1000 }),
})
const instrJson = await instrResp.json()
const instruments = instrJson.result?.instruments ?? []
const expirySet = new Set()
for (const i of instruments) {
  const p = i.instrument_name.split('-')
  if (p.length >= 4 && /^\d{8}$/.test(p[1])) expirySet.add(p[1])
}
const expiries = Array.from(expirySet).sort()
console.log(`Found ${instruments.length} instruments across ${expiries.length} expiries`)

// 2. Fetch tickers for the nearest expiry
const nearestExpiry = expiries[0]
if (!nearestExpiry) { console.error('No expiries found'); process.exit(1) }
console.log(`\nFetching tickers for nearest expiry: ${nearestExpiry}…`)

const tickerResult = await wsRequest('public/get_tickers', {
  instrument_type: 'option', currency: COIN, expiry_date: nearestExpiry,
})
const tickers = tickerResult?.tickers ?? {}
console.log(`Got ${Object.keys(tickers).length} tickers\n`)

// 3. Get spot from index field
const anyTicker = Object.values(tickers)[0]
const spot = parseFloat(anyTicker?.I ?? 0)
console.log(`Spot (from index field I): $${spot.toLocaleString()}\n`)

// 4. Sort by proximity to ATM
const calls = Object.entries(tickers).filter(([n]) => n.endsWith('-C'))
  .sort(([a], [b]) => Math.abs(+a.split('-')[2] - spot) - Math.abs(+b.split('-')[2] - spot))
  .slice(0, N_STRIKES)
const puts = Object.entries(tickers).filter(([n]) => n.endsWith('-P'))
  .sort(([a], [b]) => Math.abs(+a.split('-')[2] - spot) - Math.abs(+b.split('-')[2] - spot))
  .slice(0, N_STRIKES)

const selected = [...calls, ...puts].sort(([a], [b]) => +a.split('-')[2] - +b.split('-')[2])

console.log('══════════════════════════════════════════════════════════════════')
console.log(`RAW OUTPUT — ${COIN} expiry ${nearestExpiry} — spot $${spot.toLocaleString()}`)
console.log('══════════════════════════════════════════════════════════════════\n')

for (const [name, t] of selected) {
  const strike = name.split('-')[2]
  const type   = name.endsWith('-C') ? 'CALL' : 'PUT'
  const atm    = Math.abs(+strike - spot) < spot * 0.01 ? ' ★ATM' : ''
  const p      = t.option_pricing ?? {}
  const pct    = v => v ? (parseFloat(v) * 100).toFixed(1) + '%' : '--'

  console.log(`── ${name}  [${type}${atm}]`)
  console.log(`   bid=$${t.b}  ask=$${t.a}  bidSz=${t.B}  askSz=${t.A}  mark=$${t.M}  index=$${t.I}`)
  console.log(`   delta=${p.d}  gamma=${p.g}  theta=${p.t}  vega=${p.v}`)
  console.log(`   markIV=${pct(p.i)}  bidIV=${pct(p.bi)}  askIV=${pct(p.ai)}`)
  console.log()
}
