/**
 * Binance eapi test script
 * Tests REST endpoints for mark (Greeks) and ticker (bid/ask) for BTC + ETH options,
 * then subscribes to the optionMarkPrice WebSocket stream for a few seconds.
 *
 * Run: node backend/binance-test.mjs
 */asdasd

import { WebSocket } from 'ws'

const REST = 'https://eapi.binance.com/eapi/v1'
const WS_BASE = 'wss://fstream.binance.com/market'

async function get(path) {
  const res = await fetch(`${REST}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${path}`)
  return res.json()
}

// ─── 1. Exchange Info ─────────────────────────────────────────────────────────

console.log('\n=== 1. Exchange Info (rate limits + contract count) ===')
const info = await get('/exchangeInfo')
console.log('Rate limits:', JSON.stringify(info.rateLimits, null, 2))
const symbols = info.optionSymbols ?? []
const btcSymbols = symbols.filter(s => s.symbol.startsWith('BTC-'))
const ethSymbols = symbols.filter(s => s.symbol.startsWith('ETH-'))
console.log(`Total contracts: ${symbols.length}  BTC: ${btcSymbols.length}  ETH: ${ethSymbols.length}`)
if (btcSymbols.length > 0) {
  console.log('Sample BTC symbol:', JSON.stringify(btcSymbols[0], null, 2))
}

// ─── 2. Mark Prices + Greeks (all BTC) ───────────────────────────────────────

console.log('\n=== 2. Mark Prices + Greeks (BTC, first 3) ===')
const btcMarks = await get('/mark?underlying=BTCUSDT')
const marks = Array.isArray(btcMarks) ? btcMarks : (btcMarks.data ?? [])
console.log(`Got ${marks.length} BTC mark entries`)
if (marks.length > 0) {
  console.log('Sample mark entry:', JSON.stringify(marks[0], null, 2))
  // Check for Greeks fields
  const sample = marks[0]
  const hasGreeks = 'delta' in sample && 'gamma' in sample && 'theta' in sample && 'vega' in sample
  console.log('Has Greeks:', hasGreeks)
  console.log('Fields:', Object.keys(sample).join(', '))
}

// ─── 3. Ticker (bid/ask + 24h stats) ─────────────────────────────────────────

console.log('\n=== 3. Ticker (BTC, first 3) ===')
const btcTickers = await get('/ticker?underlying=BTCUSDT')
const tickers = Array.isArray(btcTickers) ? btcTickers : (btcTickers.data ?? [])
console.log(`Got ${tickers.length} BTC ticker entries`)
if (tickers.length > 0) {
  console.log('Sample ticker:', JSON.stringify(tickers[0], null, 2))
  console.log('Fields:', Object.keys(tickers[0]).join(', '))
}

// ─── 4. Cross-reference: merge mark + ticker for one symbol ──────────────────

console.log('\n=== 4. Merged mark+ticker for first BTC symbol ===')
if (marks.length > 0 && tickers.length > 0) {
  // Find a symbol present in both
  const markMap = Object.fromEntries(marks.map(m => [m.symbol, m]))
  const ticker = tickers.find(t => markMap[t.symbol])
  if (ticker) {
    const mark = markMap[ticker.symbol]
    console.log('Symbol:', ticker.symbol)
    console.log('bid:', ticker.bidPrice, '  ask:', ticker.askPrice, '  last:', ticker.lastPrice)
    console.log('delta:', mark.delta, '  gamma:', mark.gamma, '  theta:', mark.theta, '  vega:', mark.vega)
    console.log('markIV:', mark.markIV, '  bidIV:', mark.bidIV, '  askIV:', mark.askIV)
  }
}

// ─── 5. Orderbook depth for one symbol ───────────────────────────────────────

console.log('\n=== 5. Orderbook depth (first BTC symbol with bids) ===')
// Find a liquid symbol (has both bid and ask)
const liquidTicker = tickers.find(t => parseFloat(t.bidPrice ?? 0) > 0 && parseFloat(t.askPrice ?? 0) > 0)
const depthSymbol = liquidTicker?.symbol ?? tickers[0]?.symbol
if (depthSymbol) {
  console.log('Symbol:', depthSymbol)
  try {
    // Try without URL encoding first (raw hyphens in query string)
    const depthRes = await fetch(`${REST}/depth?symbol=${depthSymbol}&limit=10`)
    if (!depthRes.ok) {
      const body = await depthRes.text()
      console.log(`Depth HTTP ${depthRes.status}: ${body}`)
    } else {
      const depth = await depthRes.json()
      console.log('Depth:', JSON.stringify(depth, null, 2))
    }
  } catch (e) {
    console.error('Depth error:', e.message)
  }
} else {
  console.log('No BTC tickers available')
}

// ─── 6. WebSocket: optionMarkPrice stream ────────────────────────────────────

// Try different WS URL formats
console.log('\n=== 6. WebSocket: btcusdt@optionMarkPrice (10 seconds) ===')
await new Promise((resolve) => {
  // Try combined stream endpoint
  const streams = 'btcusdt@optionMarkPrice/ethusdt@optionMarkPrice'
  const url = `${WS_BASE}/stream?streams=${streams}`
  console.log('URL:', url)
  console.log('Connecting to:', url)
  const ws = new WebSocket(url)
  let msgCount = 0

  ws.on('open', () => {
    console.log('WS connected. Waiting for messages...')
    setTimeout(() => {
      ws.close()
      resolve()
    }, 10_000)
  })

  ws.on('message', (raw) => {
    msgCount++
    const msg = JSON.parse(raw.toString())
    const data = msg.data ?? msg

    // optionMarkPrice stream sends an array of contract updates
    const items = Array.isArray(data) ? data : [data]

    if (msgCount === 1) {
      console.log(`\nFirst WS message stream: ${msg.stream ?? '(no stream field)'}`)
      console.log(`Contracts in first message: ${items.length}`)
      if (items.length > 0) {
        console.log('First contract raw:', JSON.stringify(items[0], null, 2))
        // Map known fields
        const c = items[0]
        console.log(`\nField mapping:`)
        console.log(`  s (symbol):    ${c.s}`)
        console.log(`  mp (markPrice):${c.mp}`)
        console.log(`  i (indexPrice):${c.i}`)
        console.log(`  d (delta):     ${c.d}`)
        console.log(`  g (gamma):     ${c.g}`)
        console.log(`  t (theta):     ${c.t}`)
        console.log(`  v (vega):      ${c.v}`)
        console.log(`  vo (markIV):   ${c.vo}`)
        console.log(`  b (bidIV):     ${c.b}`)
        console.log(`  a (askIV):     ${c.a}`)
        console.log(`  bo (bidPrice): ${c.bo}`)
        console.log(`  ao (askPrice): ${c.ao}`)
        console.log(`  bq (bidQty):   ${c.bq}`)
        console.log(`  aq (askQty):   ${c.aq}`)
      }
    }

    if (msgCount % 5 === 0) {
      console.log(`WS messages received: ${msgCount} (latest: ${items.length} contracts)`)
    }
  })

  ws.on('error', (err) => {
    console.error('WS error:', err.message)
    resolve()
  })

  ws.on('close', () => {
    console.log(`\nWS closed. Total messages received: ${msgCount}`)
  })
})

console.log('\n=== Done ===')
