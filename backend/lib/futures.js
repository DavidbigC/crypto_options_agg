/**
 * Futures & perpetual market data polling
 * Aggregates dated futures + perps from Bybit (inverse), OKX, and Deribit
 */

const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 }

// ─── Expiry parsers ────────────────────────────────────────────────────────────

// OKX: 'BTC-USD-260925' → '2026-09-25', 'BTC-USD-SWAP' → null
function parseOkxExpiry(instId) {
  const parts = instId.split('-')
  const last = parts[parts.length - 1]
  if (last === 'SWAP' || last.length !== 6) return null
  return `20${last.slice(0,2)}-${last.slice(2,4)}-${last.slice(4,6)}`
}

// Deribit: 'BTC-13MAR26' → '2026-03-13', 'BTC-PERPETUAL' → null
function parseDeribitExpiry(name) {
  if (name.includes('PERPETUAL')) return null
  const dashIdx = name.indexOf('-')
  if (dashIdx === -1) return null
  const dateStr = name.slice(dashIdx + 1)  // e.g. '13MAR26'
  if (dateStr.length < 7) return null
  const day   = parseInt(dateStr.slice(0, 2))
  const month = MONTHS[dateStr.slice(2, 5).toUpperCase()]
  const year  = 2000 + parseInt(dateStr.slice(5, 7))
  if (!month) return null
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
}

function sortFutures(items) {
  return items.sort((a, b) => {
    if (a.isPerp && !b.isPerp) return -1
    if (!a.isPerp && b.isPerp) return  1
    return new Date(a.expiry).getTime() - new Date(b.expiry).getTime()
  })
}

// ─── Per-exchange pollers ──────────────────────────────────────────────────────

async function pollBybitFutures(coin) {
  // BTC/ETH dated futures on Bybit are category=inverse (coin-settled)
  const url = `https://api.bybit.com/v5/market/tickers?category=inverse&baseCoin=${coin}`
  const res  = await fetch(url, { headers: { 'User-Agent': 'options-viewer/1.0' } })
  const json = await res.json()
  const list = json.result?.list ?? []
  return sortFutures(list.map(t => {
    const isPerp = t.deliveryTime === '0'
    const expiry = isPerp ? null : new Date(parseInt(t.deliveryTime)).toISOString().slice(0, 10)
    return {
      symbol:    t.symbol,
      exchange:  'bybit',
      expiry,
      isPerp,
      markPrice: parseFloat(t.markPrice  || 0),
      bid:       parseFloat(t.bid1Price  || 0),
      ask:       parseFloat(t.ask1Price  || 0),
      lastPrice: parseFloat(t.lastPrice  || 0),
    }
  }))
}

async function pollOkxFutures(coin) {
  const family = `${coin}-USD`
  const headers = { 'User-Agent': 'options-viewer/1.0' }
  const [futRes, swapRes] = await Promise.all([
    fetch(`https://www.okx.com/api/v5/market/tickers?instType=FUTURES&instFamily=${family}`, { headers }),
    fetch(`https://www.okx.com/api/v5/market/tickers?instType=SWAP&instFamily=${family}`,    { headers }),
  ])
  const [futJson, swapJson] = await Promise.all([futRes.json(), swapRes.json()])
  const all = [...(swapJson.data ?? []), ...(futJson.data ?? [])]
  const items = []
  for (const t of all) {
    const isPerp = t.instId.endsWith('-SWAP')
    const expiry = isPerp ? null : parseOkxExpiry(t.instId)
    if (!isPerp && !expiry) continue
    items.push({
      symbol:    t.instId,
      exchange:  'okx',
      expiry,
      isPerp,
      markPrice: parseFloat(t.last    || 0),  // OKX ticker has no markPx
      bid:       parseFloat(t.bidPx   || 0),
      ask:       parseFloat(t.askPx   || 0),
      lastPrice: parseFloat(t.last    || 0),
    })
  }
  return sortFutures(items)
}

async function pollDeribitFutures(coin) {
  // SOL on Deribit uses currency=SOL_USDC
  const currency = coin === 'SOL' ? 'SOL_USDC' : coin
  const url  = `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future`
  const res  = await fetch(url, { headers: { 'User-Agent': 'options-viewer/1.0' } })
  const json = await res.json()
  const summaries = json.result ?? []
  const items = []
  for (const s of summaries) {
    const isPerp = s.instrument_name.includes('PERPETUAL')
    const expiry = isPerp ? null : parseDeribitExpiry(s.instrument_name)
    if (!isPerp && !expiry) continue
    items.push({
      symbol:    s.instrument_name,
      exchange:  'deribit',
      expiry,
      isPerp,
      markPrice: s.mark_price  ?? 0,
      bid:       s.bid_price   ?? 0,
      ask:       s.ask_price   ?? 0,
      lastPrice: s.last        ?? 0,
    })
  }
  return sortFutures(items)
}

// ─── Cache & polling ──────────────────────────────────────────────────────────

export const futuresCache = { BTC: [], ETH: [], SOL: [] }

export async function refreshFutures(coin) {
  const [bybit, okx, deribit] = await Promise.allSettled([
    pollBybitFutures(coin),
    pollOkxFutures(coin),
    pollDeribitFutures(coin),
  ])
  futuresCache[coin] = [
    ...(bybit.status   === 'fulfilled' ? bybit.value   : []),
    ...(okx.status     === 'fulfilled' ? okx.value     : []),
    ...(deribit.status === 'fulfilled' ? deribit.value : []),
  ]
}

export function startFuturesPolling() {
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    refreshFutures(coin).catch(() => {})
    setInterval(() => refreshFutures(coin).catch(() => {}), 10_000)
  }
  console.log('Futures polling started (10s)')
}
