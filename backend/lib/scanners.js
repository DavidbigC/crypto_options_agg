// backend/lib/scanners.js
// Ports gamma and vega scanner computation from frontend components.
// Prices are already USD-normalised — no OKX multiplier needed.
// Both bestLong and bestShort strangles are computed per expiry so the
// frontend can pick the correct one based on direction without re-computing.

function calcBreakEven(theta, gamma) {
  if (!gamma || gamma <= 0) return null
  return Math.sqrt(2 * Math.abs(theta) / gamma)
}

function getAsk(contract) {
  return (contract.bestAsk ?? contract.ask) || 0
}

function getBid(contract) {
  return (contract.bestBid ?? contract.bid) || 0
}

/**
 * Filter expirations to future dates only (same logic as frontend filterExpirations).
 * Expiry strings are YYYY-MM-DD; cutoff is T08:00:00Z on that day.
 */
function futurExpirations(expirations) {
  const now = Date.now()
  return expirations.filter(exp => new Date(exp + 'T08:00:00Z').getTime() > now)
}

// ---------------------------------------------------------------------------
// Gamma Scanner
// ---------------------------------------------------------------------------

/**
 * Returns gamma scanner rows for a given optionsData snapshot and spot price.
 * Each expiry produces up to three rows:
 *   1. ATM straddle
 *   2. bestLong strangle  — lowest break-even daily move
 *   3. bestShort strangle — highest break-even daily move (if different from bestLong)
 *
 * Row shape:
 *   { expiry, dte, type, callStrike, putStrike,
 *     askCost, bidCost, gamma, theta, be, bePct }
 */
export function computeGammaRows(optionsData, spotPrice) {
  if (!optionsData || !spotPrice) return []
  const expirations = futurExpirations(optionsData.expirations || [])
  const results = []

  for (const expiry of expirations) {
    const chain = optionsData.data[expiry]
    if (!chain?.calls?.length || !chain?.puts?.length) continue

    const dte = Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

    // ATM strike — closest to spot across calls + puts
    const allStrikes = Array.from(new Set([
      ...chain.calls.map(c => c.strike),
      ...chain.puts.map(p => p.strike),
    ]))
    const atm = allStrikes.reduce((prev, curr) =>
      Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
    )

    // ATM straddle
    const atmCall = chain.calls.find(c => c.strike === atm)
    const atmPut  = chain.puts.find(p => p.strike === atm)
    if (atmCall && atmPut) {
      const callAsk = getAsk(atmCall)
      const putAsk  = getAsk(atmPut)
      const callBid = getBid(atmCall)
      const putBid  = getBid(atmPut)
      if (callAsk && putAsk) {
        const gamma = (atmCall.gamma || 0) + (atmPut.gamma || 0)
        const theta = (atmCall.theta || 0) + (atmPut.theta || 0)
        const be    = calcBreakEven(theta, gamma)
        if (be) {
          results.push({
            expiry, dte, type: 'straddle',
            callStrike: atm, putStrike: atm,
            askCost: callAsk + putAsk,
            bidCost: callBid + putBid,
            gamma, theta, be,
            bePct: (be / spotPrice) * 100,
          })
        }
      }
    }

    // OTM contracts for strangles
    const DELTA_TOL = 0.15
    const otmCalls = chain.calls.filter(c => c.strike > spotPrice && (c.gamma || 0) > 0 && c.theta)
    const otmPuts  = chain.puts.filter(p => p.strike < spotPrice && (p.gamma || 0) > 0 && p.theta)
    const hasDelta = otmCalls.some(c => c.delta !== undefined && c.delta !== 0)

    let bestLong  = null  // lowest be  (long gamma)
    let bestShort = null  // highest be (short gamma)

    for (const call of otmCalls) {
      for (const put of otmPuts) {
        if (hasDelta && Math.abs((call.delta || 0) + (put.delta || 0)) > DELTA_TOL) continue
        const gamma = (call.gamma || 0) + (put.gamma || 0)
        const theta = (call.theta || 0) + (put.theta || 0)
        const be    = calcBreakEven(theta, gamma)
        if (!be) continue

        const callAsk = getAsk(call)
        const putAsk  = getAsk(put)
        if (!callAsk || !putAsk) continue

        const callBid = getBid(call)
        const putBid  = getBid(put)
        const candidate = {
          expiry, dte, type: 'strangle',
          callStrike: call.strike, putStrike: put.strike,
          askCost: callAsk + putAsk,
          bidCost: callBid + putBid,
          gamma, theta, be,
          bePct: (be / spotPrice) * 100,
        }

        if (!bestLong || be < bestLong.be) bestLong = candidate
        if (!bestShort || be > bestShort.be) bestShort = candidate
      }
    }

    if (bestLong) results.push(bestLong)
    // Only add bestShort if it is a distinct strangle from bestLong
    if (bestShort && bestShort !== bestLong) results.push(bestShort)
  }

  return results
}

// ---------------------------------------------------------------------------
// Vega Scanner
// ---------------------------------------------------------------------------

/**
 * Returns vega scanner rows for a given optionsData snapshot and spot price.
 * Each expiry produces up to three rows:
 *   1. ATM straddle
 *   2. bestLong strangle  — highest vegaPerDollar
 *   3. bestShort strangle — highest beIVMove (if different from bestLong)
 *
 * Row shape:
 *   { expiry, dte, type, callStrike, putStrike,
 *     askCost, bidCost, vega, theta, markIV, vegaPerDollar, beIVMove }
 */
export function computeVegaRows(optionsData, spotPrice) {
  if (!optionsData || !spotPrice) return []
  const expirations = futurExpirations(optionsData.expirations || [])
  const results = []

  for (const expiry of expirations) {
    const chain = optionsData.data[expiry]
    if (!chain?.calls?.length || !chain?.puts?.length) continue

    const dte = Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

    // ATM strike
    const allStrikes = Array.from(new Set([
      ...chain.calls.map(c => c.strike),
      ...chain.puts.map(p => p.strike),
    ]))
    const atm = allStrikes.reduce((prev, curr) =>
      Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
    )

    const makeVegaRow = (type, call, put, callAsk, putAsk, callBid, putBid) => {
      const vega  = (call.vega  || 0) + (put.vega  || 0)
      const theta = (call.theta || 0) + (put.theta || 0)
      if (!vega) return null
      const askCost = callAsk + putAsk
      if (!askCost) return null
      const bidCost = callBid + putBid
      const markIV = ((call.markVol || 0) + (put.markVol || 0)) / 2
      const vegaPerDollar = vega / askCost
      const beIVMove = (askCost / vega) * 100
      return {
        expiry, dte, type,
        callStrike: call.strike, putStrike: put.strike,
        askCost, bidCost,
        vega, theta, markIV,
        vegaPerDollar, beIVMove,
      }
    }

    // ATM straddle
    const atmCall = chain.calls.find(c => c.strike === atm)
    const atmPut  = chain.puts.find(p => p.strike === atm)
    if (atmCall && atmPut) {
      const callAsk = getAsk(atmCall)
      const putAsk  = getAsk(atmPut)
      if (callAsk && putAsk) {
        const row = makeVegaRow('straddle', atmCall, atmPut, callAsk, putAsk, getBid(atmCall), getBid(atmPut))
        if (row) results.push(row)
      }
    }

    // OTM contracts for strangles
    const DELTA_TOL = 0.15
    const otmCalls = chain.calls.filter(c => c.strike > spotPrice && (c.vega || 0) > 0)
    const otmPuts  = chain.puts.filter(p => p.strike < spotPrice && (p.vega || 0) > 0)
    const hasDelta = otmCalls.some(c => c.delta !== undefined && c.delta !== 0)

    let bestLong  = null  // highest vegaPerDollar
    let bestShort = null  // highest beIVMove

    for (const call of otmCalls) {
      for (const put of otmPuts) {
        if (hasDelta && Math.abs((call.delta || 0) + (put.delta || 0)) > DELTA_TOL) continue
        const callAsk = getAsk(call)
        const putAsk  = getAsk(put)
        if (!callAsk || !putAsk) continue
        const row = makeVegaRow('strangle', call, put, callAsk, putAsk, getBid(call), getBid(put))
        if (!row) continue

        if (!bestLong  || row.vegaPerDollar > bestLong.vegaPerDollar)  bestLong  = row
        if (!bestShort || row.beIVMove      > bestShort.beIVMove)      bestShort = row
      }
    }

    if (bestLong) results.push(bestLong)
    if (bestShort && bestShort !== bestLong) results.push(bestShort)
  }

  return results
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export const scannerCache = {}

/**
 * Re-compute and store gamma + vega rows for a given cache key.
 * Typically called after options data or spot price updates.
 */
export function updateScannerCache(cacheKey, response, spotPrice) {
  if (!response || !spotPrice) return
  scannerCache[cacheKey] = {
    gamma: computeGammaRows(response, spotPrice),
    vega:  computeVegaRows(response, spotPrice),
    updatedAt: Date.now(),
  }
}
