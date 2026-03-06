/**
 * Derive (derive.xyz / Lyra Finance) options data
 * Prices + Greeks come from derive-ws.js (WebSocket, live)
 * Instrument metadata refreshed via REST every 60s
 *
 * Supported coins: BTC, ETH (SOL not listed on Derive)
 */

import { deriveTickersCache, deriveSpotCache } from './derive-ws.js'

const DERIVE_REST = 'https://api.lyra.finance'

// Parse instrument name: "BTC-20260307-70000-C" → { expiry, strike, optionType }
function parseDeriveInstrument(name) {
  const parts = name.split('-')
  if (parts.length < 4) return null
  const datePart = parts[1]
  if (!/^\d{8}$/.test(datePart)) return null
  const expiry     = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
  const strike     = parseFloat(parts[2])
  const optionType = parts[3] === 'C' ? 'call' : 'put'
  return { expiry, strike, optionType }
}

export function buildDeriveResponse(coin) {
  const spotPrice = deriveSpotCache[coin] ?? 0
  const optionsByDate = {}

  for (const [name, ticker] of Object.entries(deriveTickersCache)) {
    // Filter to the requested coin
    if (!name.startsWith(`${coin}-`)) continue

    const parsed = parseDeriveInstrument(name)
    if (!parsed) continue

    const { expiry, strike, optionType } = parsed
    const p = ticker.option_pricing ?? {}

    const bid       = parseFloat(ticker.b ?? 0)
    const ask       = parseFloat(ticker.a ?? 0)
    const last      = parseFloat(ticker.f ?? 0)
    const markPrice = parseFloat(p.m ?? ticker.M ?? 0)
    const markVol   = parseFloat(p.i ?? 0)   // IV as decimal

    const contract = {
      symbol:            name,
      strike,
      optionType,
      bid,
      ask,
      last,
      volume:            parseFloat(ticker.stats?.v ?? 0),
      bidSize:           parseFloat(ticker.B ?? 0),
      askSize:           parseFloat(ticker.A ?? 0),
      delta:             parseFloat(p.d ?? 0),
      gamma:             parseFloat(p.g ?? 0),
      theta:             parseFloat(p.t ?? 0),
      vega:              parseFloat(p.v ?? 0),
      impliedVolatility: markVol,
      openInterest:      parseFloat(ticker.stats?.oi ?? 0),
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
