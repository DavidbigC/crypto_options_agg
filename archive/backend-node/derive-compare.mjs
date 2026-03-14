/**
 * Compare ticker_slim subscriptions vs public/get_tickers for the same expiry.
 * Run: node derive-compare.mjs [EXPIRY e.g. 20260307]
 */
import { WebSocket } from 'ws'

const EXPIRY = process.argv[2] ?? '20260307'
const COIN   = 'BTC'
const WS_URL = 'wss://api.lyra.finance/ws'

// 1. Get instrument names for this expiry via REST
const instrResp = await fetch('https://api.lyra.finance/public/get_all_instruments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expired: false, instrument_type: 'option', currency: COIN, page_size: 1000 }),
})
const instrJson = await instrResp.json()
const names = (instrJson.result?.instruments ?? [])
  .map(i => i.instrument_name)
  .filter(n => n.startsWith(`${COIN}-${EXPIRY}-`))

console.log(`Found ${names.length} instruments for ${COIN}-${EXPIRY}\n`)
if (names.length === 0) { console.error('No instruments found — check expiry date'); process.exit(1) }

// 2. Open one WS, run both methods concurrently
const slimData   = {}   // instrument → ticker from ticker_slim
const tickerData = {}   // instrument → ticker from get_tickers

await new Promise(resolve => {
  const ws = new WebSocket(WS_URL)
  let reqId = 1
  let getTickersDone = false
  let slimDone = false

  const tryResolve = () => { if (getTickersDone && slimDone) { ws.close(); resolve() } }

  ws.on('open', () => {
    // A: subscribe to ticker_slim for each instrument
    const slimChannels = names.map(n => `ticker_slim.${n}.100`)
    // Subscribe in chunks of 200
    for (let i = 0; i < slimChannels.length; i += 200) {
      ws.send(JSON.stringify({
        method: 'subscribe',
        params: { channels: slimChannels.slice(i, i + 200) },
        id: reqId++,
      }))
    }

    // B: call get_tickers for this expiry
    ws.send(JSON.stringify({
      method: 'public/get_tickers',
      params: { instrument_type: 'option', currency: COIN, expiry_date: EXPIRY },
      id: 99,
    }))
  })

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw) } catch { return }

    // get_tickers response
    if (msg.id === 99) {
      for (const [name, t] of Object.entries(msg.result?.tickers ?? {})) {
        tickerData[name] = t
      }
      getTickersDone = true
      console.log(`get_tickers: got ${Object.keys(tickerData).length} instruments`)
      tryResolve()
      return
    }

    // ticker_slim subscription push
    if (msg.method === 'subscription') {
      const { channel, data } = msg.params ?? {}
      if (!channel?.startsWith('ticker_slim.') || !data?.instrument_ticker) return
      const name = channel.split('.').slice(1, -1).join('.')
      slimData[name] = data.instrument_ticker
      if (Object.keys(slimData).length >= names.length) {
        slimDone = true
        console.log(`ticker_slim: got ${Object.keys(slimData).length} instruments`)
        tryResolve()
      }
    }
  })

  ws.on('error', err => { console.error('WS error:', err.message); resolve() })
  setTimeout(() => { ws.close(); resolve() }, 15000)
})

// 3. Compare
console.log('\n══════════════════════════════════════════════════════════════════')
console.log(`COMPARISON — ${COIN} expiry ${EXPIRY}`)
console.log('get_tickers vs ticker_slim')
console.log('══════════════════════════════════════════════════════════════════\n')

// Pick near-ATM strikes (sort by strike, take middle ones)
const allStrikes = [...new Set(names.map(n => +n.split('-')[2]))].sort((a,b) => a-b)
const spot = parseFloat(Object.values(tickerData)[0]?.I ?? 0)
console.log(`Spot (from get_tickers index field): $${spot.toLocaleString()}\n`)

const nearAtm = allStrikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, 5)

let diffs = 0
for (const strike of nearAtm.sort((a,b) => a-b)) {
  for (const type of ['C', 'P']) {
    const name = `${COIN}-${EXPIRY}-${strike}-${type}`
    const gt = tickerData[name]
    const sl = slimData[name]

    if (!gt && !sl) continue

    const gtBid = gt?.b ?? '--', gtAsk = gt?.a ?? '--'
    const slBid = sl?.b ?? '--', slAsk = sl?.a ?? '--'
    const gtIV  = gt?.option_pricing?.i ? (parseFloat(gt.option_pricing.i)*100).toFixed(1)+'%' : '--'
    const slIV  = sl?.option_pricing?.i ? (parseFloat(sl.option_pricing.i)*100).toFixed(1)+'%' : '--'

    const bidMatch = gtBid === slBid
    const askMatch = gtAsk === slAsk
    const flag = (!bidMatch || !askMatch) ? ' ⚠️' : ' ✓'
    if (!bidMatch || !askMatch) diffs++

    console.log(`${name}${flag}`)
    console.log(`  get_tickers: bid=$${gtBid}  ask=$${gtAsk}  IV=${gtIV}`)
    console.log(`  ticker_slim: bid=$${slBid}  ask=$${slAsk}  IV=${slIV}`)
    if (!bidMatch) console.log(`    bid diff: ${gtBid} vs ${slBid}`)
    if (!askMatch) console.log(`    ask diff: ${gtAsk} vs ${slAsk}`)
    console.log()
  }
}

console.log(`─────────────────────────────────────────`)
console.log(`Instruments with bid/ask diff: ${diffs} / ${nearAtm.length * 2}`)
console.log(`get_tickers total: ${Object.keys(tickerData).length}`)
console.log(`ticker_slim total: ${Object.keys(slimData).length}`)
