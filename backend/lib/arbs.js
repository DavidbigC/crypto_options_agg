// Arb detection strategies — ported from frontend/lib/strategies/

const TAKER_FEE = 0.0003
const FEE_CAP = { bybit: 0.07, okx: 0.07, deribit: 0.125 }

function applyFee(price, side, ex, spotPrice) {
  if (price === 0) return 0
  const cap = FEE_CAP[ex ?? ''] ?? 0.07
  const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
  return side === 'buy' ? price + fee : price - fee
}

function calcApr(profit, collateral, daysToExpiry) {
  if (collateral <= 0 || daysToExpiry <= 0) return 0
  return (profit / collateral) * (365 / daysToExpiry) * 100
}

function pickHedge(optionsExpiry, futures, now = Date.now()) {
  const optsDays = (new Date(optionsExpiry).getTime() - now) / 86_400_000
  if (optsDays <= 0) return null

  const threshold = optsDays * 0.10
  let bestDated = null
  let bestDist = Infinity
  for (const f of futures) {
    if (f.isPerp || !f.expiry || f.markPrice <= 0) continue
    const futDays = (new Date(f.expiry).getTime() - now) / 86_400_000
    const dist = Math.abs(futDays - optsDays)
    if (dist < threshold && dist < bestDist) { bestDated = f; bestDist = dist }
  }
  if (bestDated) return { price: bestDated.markPrice, exchange: bestDated.exchange, isPerp: false }

  const perp = futures.find(f => f.isPerp && f.markPrice > 0)
  return perp ? { price: perp.markPrice, exchange: perp.exchange, isPerp: true } : null
}

function getPrice(contract, side) {
  if (side === 'buy') {
    const val = contract.bestAsk ?? contract.ask ?? 0
    const ex  = contract.bestAskEx ?? null
    return { val, ex }
  }
  const val = contract.bestBid ?? contract.bid ?? 0
  const ex  = contract.bestBidEx ?? null
  return { val, ex }
}

export function findBoxSpreads(optionsData, spotPrice, minProfit = 0) {
  const results = []

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const calls = chainData.calls
    const puts  = chainData.puts
    if (!calls || !puts) continue

    const callsMap = new Map()
    const putsMap  = new Map()
    for (const c of calls) if (c.bestBid > 0 || c.bestAsk > 0) callsMap.set(c.strike, c)
    for (const p of puts)  if (p.bestBid > 0 || p.bestAsk > 0) putsMap.set(p.strike, p)

    const lo = spotPrice * 0.6
    const hi = spotPrice * 1.4
    const strikes = Array.from(
      new Set([...callsMap.keys(), ...putsMap.keys()])
    ).filter(s => s >= lo && s <= hi).sort((a, b) => a - b)

    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        const k1 = strikes[i], k2 = strikes[j]
        const c1 = callsMap.get(k1), c2 = callsMap.get(k2)
        const p1 = putsMap.get(k1),  p2 = putsMap.get(k2)
        if (!c1 || !c2 || !p1 || !p2) continue
        const boxValue = k2 - k1

        // Long box: buy C(K1) ask, sell C(K2) bid, buy P(K2) ask, sell P(K1) bid
        const lc1a = getPrice(c1, 'buy')
        const lc2b = getPrice(c2, 'sell')
        const lp2a = getPrice(p2, 'buy')
        const lp1b = getPrice(p1, 'sell')
        if (lc1a.val > 0 && lc2b.val > 0 && lp2a.val > 0 && lp1b.val > 0) {
          const cost   = applyFee(lc1a.val, 'buy',  lc1a.ex, spotPrice)
                       - applyFee(lc2b.val, 'sell', lc2b.ex, spotPrice)
                       + applyFee(lp2a.val, 'buy',  lp2a.ex, spotPrice)
                       - applyFee(lp1b.val, 'sell', lp1b.ex, spotPrice)
          const profit = boxValue - cost
          if (profit > minProfit) results.push({
            expiry, k1, k2, type: 'long', profit, cost, boxValue,
            legs: [
              { action: 'buy',  type: 'call', strike: k1, price: lc1a.val, exchange: lc1a.ex },
              { action: 'sell', type: 'call', strike: k2, price: lc2b.val, exchange: lc2b.ex },
              { action: 'buy',  type: 'put',  strike: k2, price: lp2a.val, exchange: lp2a.ex },
              { action: 'sell', type: 'put',  strike: k1, price: lp1b.val, exchange: lp1b.ex },
            ],
          })
        }

        // Short box: sell C(K1) bid, buy C(K2) ask, sell P(K2) bid, buy P(K1) ask
        const sc1b = getPrice(c1, 'sell')
        const sc2a = getPrice(c2, 'buy')
        const sp2b = getPrice(p2, 'sell')
        const sp1a = getPrice(p1, 'buy')
        if (sc1b.val > 0 && sc2a.val > 0 && sp2b.val > 0 && sp1a.val > 0) {
          const revenue = applyFee(sc1b.val, 'sell', sc1b.ex, spotPrice)
                        - applyFee(sc2a.val, 'buy',  sc2a.ex, spotPrice)
                        + applyFee(sp2b.val, 'sell', sp2b.ex, spotPrice)
                        - applyFee(sp1a.val, 'buy',  sp1a.ex, spotPrice)
          const profit  = revenue - boxValue
          if (profit > minProfit) results.push({
            expiry, k1, k2, type: 'short', profit, cost: revenue, boxValue,
            legs: [
              { action: 'sell', type: 'call', strike: k1, price: sc1b.val, exchange: sc1b.ex },
              { action: 'buy',  type: 'call', strike: k2, price: sc2a.val, exchange: sc2a.ex },
              { action: 'sell', type: 'put',  strike: k2, price: sp2b.val, exchange: sp2b.ex },
              { action: 'buy',  type: 'put',  strike: k1, price: sp1a.val, exchange: sp1a.ex },
            ],
          })
        }
      }
    }
  }
  return results
}

export function findVerticalArbs(optionsData, spotPrice, minProfit = 0) {
  const results = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const daysToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / 86_400_000)

    for (const [optType, contracts] of [
      ['call', chainData.calls],
      ['put',  chainData.puts],
    ]) {
      if (!contracts) continue
      const sorted = contracts
        .filter(c => c.strike >= lo && c.strike <= hi)
        .sort((a, b) => a.strike - b.strike)

      for (let i = 0; i + 1 < sorted.length; i++) {
        const cLow  = sorted[i]
        const cHigh = sorted[i + 1]

        if (optType === 'call') {
          const bAsk = getPrice(cLow,  'buy')
          const sBid = getPrice(cHigh, 'sell')
          if (bAsk.val <= 0 || sBid.val <= 0) continue
          const paid     = applyFee(bAsk.val, 'buy',  bAsk.ex, spotPrice)
          const received = applyFee(sBid.val, 'sell', sBid.ex, spotPrice)
          const profit   = received - paid
          if (profit > minProfit) results.push({
            strategy: 'call_monotonicity', expiry,
            profit, apr: calcApr(profit, bAsk.val, daysToExpiry), collateral: bAsk.val,
            legs: [
              { action: 'buy',  type: 'call', strike: cLow.strike,  expiry, qty: 1, price: bAsk.val, exchange: bAsk.ex },
              { action: 'sell', type: 'call', strike: cHigh.strike, expiry, qty: 1, price: sBid.val, exchange: sBid.ex },
            ],
          })
        } else {
          const sBid = getPrice(cLow,  'sell')
          const bAsk = getPrice(cHigh, 'buy')
          if (sBid.val <= 0 || bAsk.val <= 0) continue
          const received = applyFee(sBid.val, 'sell', sBid.ex, spotPrice)
          const paid     = applyFee(bAsk.val, 'buy',  bAsk.ex, spotPrice)
          const profit   = received - paid
          if (profit > minProfit) results.push({
            strategy: 'put_monotonicity', expiry,
            profit, apr: calcApr(profit, bAsk.val, daysToExpiry), collateral: bAsk.val,
            legs: [
              { action: 'sell', type: 'put', strike: cLow.strike,  expiry, qty: 1, price: sBid.val, exchange: sBid.ex },
              { action: 'buy',  type: 'put', strike: cHigh.strike, expiry, qty: 1, price: bAsk.val, exchange: bAsk.ex },
            ],
          })
        }
      }
    }
  }
  return results
}

export function findButterflyArbs(optionsData, spotPrice, minProfit = 0) {
  const results = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const daysToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / 86_400_000)

    for (const [optType, contracts] of [
      ['call', chainData.calls],
      ['put',  chainData.puts],
    ]) {
      if (!contracts) continue
      const sorted = contracts
        .filter(c => c.strike >= lo && c.strike <= hi)
        .sort((a, b) => a.strike - b.strike)

      for (let i = 0; i + 2 < sorted.length; i++) {
        const c1 = sorted[i], c2 = sorted[i + 1], c3 = sorted[i + 2]
        const leftGap  = c2.strike - c1.strike
        const rightGap = c3.strike - c2.strike
        if (Math.abs(leftGap - rightGap) / leftGap > 0.05) continue

        const w1 = getPrice(c1, 'buy')
        const m2 = getPrice(c2, 'sell')
        const w3 = getPrice(c3, 'buy')
        if (w1.val <= 0 || m2.val <= 0 || w3.val <= 0) continue

        const paid1 = applyFee(w1.val, 'buy',  w1.ex, spotPrice)
        const recv2 = applyFee(m2.val, 'sell', m2.ex, spotPrice) * 2
        const paid3 = applyFee(w3.val, 'buy',  w3.ex, spotPrice)
        const profit = -(paid1 - recv2 + paid3)
        if (profit > minProfit) {
          const collateral = leftGap
          results.push({
            strategy: optType === 'call' ? 'call_butterfly' : 'put_butterfly',
            expiry, profit, apr: calcApr(profit, collateral, daysToExpiry), collateral,
            legs: [
              { action: 'buy',  type: optType, strike: c1.strike, expiry, qty: 1, price: w1.val, exchange: w1.ex },
              { action: 'sell', type: optType, strike: c2.strike, expiry, qty: 2, price: m2.val, exchange: m2.ex },
              { action: 'buy',  type: optType, strike: c3.strike, expiry, qty: 1, price: w3.val, exchange: w3.ex },
            ],
          })
        }
      }
    }
  }
  return results
}

export function findCalendarArbs(optionsData, spotPrice, minProfit = 0) {
  const results = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  const groups = new Map()
  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    for (const [optType, contracts] of [
      ['call', chainData.calls],
      ['put',  chainData.puts],
    ]) {
      if (!contracts) continue
      for (const c of contracts) {
        if (c.strike < lo || c.strike > hi) continue
        const key = `${c.strike}|${optType}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push({ ...c, expiry })
      }
    }
  }

  for (const [key, entries] of groups) {
    if (entries.length < 2) continue
    const optType = key.split('|')[1]
    entries.sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime())

    for (let i = 0; i + 1 < entries.length; i++) {
      const near = entries[i]
      const far  = entries[i + 1]
      const bidNear = getPrice(near, 'sell')
      const askFar  = getPrice(far,  'buy')
      if (bidNear.val <= 0 || askFar.val <= 0) continue

      const received = applyFee(bidNear.val, 'sell', bidNear.ex, spotPrice)
      const paid     = applyFee(askFar.val,  'buy',  askFar.ex,  spotPrice)
      const profit   = received - paid
      if (profit > minProfit) {
        const daysToNear = Math.max(1, (new Date(near.expiry).getTime() - Date.now()) / 86_400_000)
        results.push({
          strategy: 'calendar_arb',
          expiry: near.expiry,
          profit, apr: calcApr(profit, askFar.val, daysToNear), collateral: askFar.val,
          legs: [
            { action: 'sell', type: optType, strike: near.strike, expiry: near.expiry, qty: 1, price: bidNear.val, exchange: bidNear.ex },
            { action: 'buy',  type: optType, strike: far.strike,  expiry: far.expiry,  qty: 1, price: askFar.val,  exchange: askFar.ex  },
          ],
        })
      }
    }
  }
  return results
}

export function findPCPArbs(optionsData, spotPrice, futures = [], minProfit = 0) {
  const results = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const fwd = chainData.forwardPrice > 0 ? chainData.forwardPrice : spotPrice
    const hedge = pickHedge(expiry, futures)
    const hedgePrice = hedge?.price ?? fwd
    const daysToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / 86_400_000)

    const callsByStrike = new Map()
    const putsByStrike  = new Map()
    for (const c of (chainData.calls ?? [])) {
      if (c.strike >= lo && c.strike <= hi) callsByStrike.set(c.strike, c)
    }
    for (const p of (chainData.puts ?? [])) {
      if (p.strike >= lo && p.strike <= hi) putsByStrike.set(p.strike, p)
    }

    for (const [strike, call] of callsByStrike) {
      const put = putsByStrike.get(strike)
      if (!put) continue

      const theoreticalCPDiff = fwd - strike

      // Conversion: sell C + buy P
      const callBid = getPrice(call, 'sell')
      const putAsk  = getPrice(put,  'buy')
      if (callBid.val > 0 && putAsk.val > 0) {
        const received = applyFee(callBid.val, 'sell', callBid.ex, spotPrice)
        const paid     = applyFee(putAsk.val,  'buy',  putAsk.ex,  spotPrice)
        const profit   = (received - paid) - theoreticalCPDiff
        if (profit > minProfit) {
          const collateral = 0.1 * spotPrice + callBid.val
          results.push({
            strategy: 'pcp_conversion',
            expiry, profit,
            apr: calcApr(profit, collateral, daysToExpiry),
            collateral,
            legs: [
              { action: 'sell',  type: 'call',   strike, expiry, qty: 1, price: callBid.val, exchange: callBid.ex },
              { action: 'buy',   type: 'put',    strike, expiry, qty: 1, price: putAsk.val,  exchange: putAsk.ex  },
              { action: 'buy',   type: 'future', strike: 0, expiry, qty: 1, price: hedgePrice, exchange: hedge?.exchange ?? callBid.ex },
            ],
          })
        }
      }

      // Reversal: buy C + sell P
      const callAsk = getPrice(call, 'buy')
      const putBid  = getPrice(put,  'sell')
      if (callAsk.val > 0 && putBid.val > 0) {
        const paid     = applyFee(callAsk.val, 'buy',  callAsk.ex, spotPrice)
        const received = applyFee(putBid.val,  'sell', putBid.ex,  spotPrice)
        const profit   = theoreticalCPDiff - (paid - received)
        if (profit > minProfit) {
          const collateral = 0.1 * spotPrice + putBid.val
          results.push({
            strategy: 'pcp_reversal',
            expiry, profit,
            apr: calcApr(profit, collateral, daysToExpiry),
            collateral,
            legs: [
              { action: 'buy',  type: 'call',   strike, expiry, qty: 1, price: callAsk.val, exchange: callAsk.ex },
              { action: 'sell', type: 'put',    strike, expiry, qty: 1, price: putBid.val,  exchange: putBid.ex  },
              { action: 'sell', type: 'future', strike: 0, expiry, qty: 1, price: hedgePrice, exchange: hedge?.exchange ?? callAsk.ex },
            ],
          })
        }
      }
    }
  }
  return results
}

export function findAllArbs(optionsData, spotPrice, futures = []) {
  return [
    ...findVerticalArbs(optionsData, spotPrice),
    ...findButterflyArbs(optionsData, spotPrice),
    ...findCalendarArbs(optionsData, spotPrice),
    ...findPCPArbs(optionsData, spotPrice, futures),
  ]
}

export const arbCache = {}

export function updateArbCache(coin, combinedResponse, spotPrice, futures = []) {
  arbCache[coin] = {
    boxSpreads: findBoxSpreads(combinedResponse, spotPrice),
    allArbs: findAllArbs(combinedResponse, spotPrice, futures),
    updatedAt: Date.now(),
  }
}
