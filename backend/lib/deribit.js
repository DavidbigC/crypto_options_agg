/**
 * Deribit options polling
 * Endpoint: GET /api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 * Prices: BTC/ETH options are inverse (priced in coin) → convert to USD via underlying_price
 *         SOL_USDC options are linear (priced in USDC) → already USD
 * Greeks: provided by deribit-ws.js via ticker.{instrument}.100ms subscriptions
 */

import { deribitGreeksCache } from './deribit-ws.js'

const DERIBIT_BASE = 'https://www.deribit.com/api/v2'

const DERIBIT_COINS = {
  BTC: { currency: 'BTC',      priceInCoin: true,  indexName: 'btc_usd' },
  ETH: { currency: 'ETH',      priceInCoin: true,  indexName: 'eth_usd' },
  SOL: { currency: 'SOL_USDC', priceInCoin: false, indexName: 'sol_usd' },
}

export const deribitCache = {
  BTC: { summaries: [], spot: 0 },
  ETH: { summaries: [], spot: 0 },
  SOL: { summaries: [], spot: 0 },
}

// ─── Instrument name parser ───────────────────────────────────────────────────
// Format: BTC-27DEC24-100000-C  or  SOL_USDC-27DEC24-200-C
const MONTHS = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 }

function parseDeribitInstName(name) {
  // Split on '-', skipping the currency prefix (which may contain '_')
  // e.g. 'SOL_USDC-27DEC24-200-C' → parts = ['SOL_USDC','27DEC24','200','C']
  const dashIdx = name.indexOf('-')
  if (dashIdx === -1) return null
  const rest = name.slice(dashIdx + 1).split('-')
  if (rest.length < 3) return null

  const dateStr  = rest[0]
  const strike   = parseFloat(rest[1])
  const optionType = rest[2] === 'C' ? 'call' : 'put'

  let day, monthStr, year
  if (dateStr.length === 6) {
    day = parseInt(dateStr.slice(0, 1))
    monthStr = dateStr.slice(1, 4)
    year = parseInt('20' + dateStr.slice(4, 6))
  } else if (dateStr.length === 7) {
    day = parseInt(dateStr.slice(0, 2))
    monthStr = dateStr.slice(2, 5)
    year = parseInt('20' + dateStr.slice(5, 7))
  } else {
    return null
  }

  const month = MONTHS[monthStr]
  if (!month) return null

  const expiry = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`
  return { expiry, strike, optionType }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
async function pollDeribitSpot(coin) {
  const config = DERIBIT_COINS[coin]
  if (!config) return
  try {
    const url = `${DERIBIT_BASE}/public/get_index_price?index_name=${config.indexName}`
    const res = await fetch(url, { headers: { 'User-Agent': 'deribit-options-viewer/1.0' } })
    const json = await res.json()
    const price = json.result?.index_price ?? 0
    if (price > 0) deribitCache[coin].spot = price
  } catch (err) {
    console.error(`Deribit spot poll error (${coin}):`, err.message)
  }
}

export async function pollDeribitOptions(coin) {
  const config = DERIBIT_COINS[coin]
  if (!config) return

  try {
    const url = `${DERIBIT_BASE}/public/get_book_summary_by_currency?currency=${config.currency}&kind=option`
    const res = await fetch(url, { headers: { 'User-Agent': 'deribit-options-viewer/1.0' } })
    const json = await res.json()

    if (json.error || !Array.isArray(json.result)) {
      console.error(`Deribit poll error (${coin}):`, json.error?.message ?? 'bad response')
      return
    }

    deribitCache[coin].summaries = json.result
  } catch (err) {
    console.error(`Deribit poll error (${coin}):`, err.message)
  }
}

export function startDeribitPolling() {
  const coins = Object.keys(DERIBIT_COINS)
  coins.forEach((coin, i) => {
    setTimeout(() => {
      pollDeribitSpot(coin)
      pollDeribitOptions(coin)
      setInterval(() => pollDeribitSpot(coin), 5000)
      setInterval(() => pollDeribitOptions(coin), 5000)
    }, i * 2000)
  })
  console.log('Deribit polling started')
}

// ─── Build OptionsData response from cache ────────────────────────────────────
export function buildDeribitResponse(coin) {
  const config = DERIBIT_COINS[coin]
  const cache  = deribitCache[coin]
  if (!config || !cache) return null

  const spotPrice = cache.spot
  const coinMult  = config.priceInCoin ? spotPrice : 1  // BTC/ETH → multiply; SOL_USDC → 1

  const optionsByDate = {}

  for (const s of cache.summaries) {
    const parsed = parseDeribitInstName(s.instrument_name)
    if (!parsed) continue

    const { expiry, strike, optionType } = parsed

    const bid       = (s.bid_price  ?? 0) * coinMult
    const ask       = (s.ask_price  ?? 0) * coinMult
    const markPrice = (s.mark_price ?? 0) * coinMult
    const markVol   = (s.mark_iv ?? 0) / 100  // Deribit returns percentage (60 = 60% IV) → convert to decimal

    // Use greeks from Deribit's WS ticker feed (already in USD)
    const g = deribitGreeksCache[s.instrument_name]

    const contract = {
      symbol:            s.instrument_name,
      strike,
      optionType,
      bid,
      ask,
      last:              (s.last ?? 0) * coinMult,
      volume:            s.volume ?? 0,
      bidSize:           0,
      askSize:           0,
      delta:             g?.delta  ?? 0,
      gamma:             g?.gamma  ?? 0,
      theta:             g?.theta  ?? 0,
      vega:              g?.vega   ?? 0,
      impliedVolatility: markVol,
      openInterest:      s.open_interest ?? 0,
      markPrice,
      markVol,
    }

    if (!optionsByDate[expiry]) optionsByDate[expiry] = { calls: [], puts: [] }
    if (optionType === 'call') optionsByDate[expiry].calls.push(contract)
    else                       optionsByDate[expiry].puts.push(contract)
  }

  const sortedDates = Object.keys(optionsByDate).sort()
  const expirationCounts = {}
  for (const date of sortedDates) {
    expirationCounts[date] = {
      calls: optionsByDate[date].calls.length,
      puts:  optionsByDate[date].puts.length,
    }
  }

  return { spotPrice, expirations: sortedDates, expirationCounts, data: optionsByDate }
}
