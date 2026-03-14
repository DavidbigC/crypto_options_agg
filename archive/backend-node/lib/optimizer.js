// backend/lib/optimizer.js
// Greek optimizer: enumerates multi-leg strategy templates against combined options data
// and scores each against user-supplied Greek targets.

// ─── Constants ───────────────────────────────────────────────────────────────

const EXCHANGES = ['bybit', 'okx', 'deribit']

const TAKER_FEE = 0.0003
const FEE_CAP = { bybit: 0.07, okx: 0.07, deribit: 0.125 }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function futureExpirations(expirations) {
  const now = Date.now()
  return (expirations || []).filter(exp => new Date(exp + 'T08:00:00Z').getTime() > now)
}

function dte(expiry) {
  return Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)
}

function bestAsk(contract, exchanges) {
  let best = 0
  for (const ex of exchanges) {
    const raw = contract.prices?.[ex]?.ask || 0
    if (raw > 0 && (best === 0 || raw < best)) best = raw
  }
  return best
}

function bestBid(contract, exchanges) {
  let best = 0
  for (const ex of exchanges) {
    const raw = contract.prices?.[ex]?.bid || 0
    if (raw > best) best = raw
  }
  return best
}

function bestExchange(contract, side, exchanges) {
  let bestVal = 0
  let bestEx = null
  for (const ex of exchanges) {
    const raw = side === 'buy'
      ? (contract.prices?.[ex]?.ask || 0)
      : (contract.prices?.[ex]?.bid || 0)
    if (raw > 0) {
      if (side === 'buy' && (bestVal === 0 || raw < bestVal)) { bestVal = raw; bestEx = ex }
      if (side === 'sell' && raw > bestVal) { bestVal = raw; bestEx = ex }
    }
  }
  return { price: bestVal, exchange: bestEx }
}

function withFee(price, side, exchange, spotPrice) {
  if (!price) return 0
  const cap = FEE_CAP[exchange] ?? 0.07
  const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
  return side === 'buy' ? price + fee : price - fee
}

function findContract(chain, strike, type) {
  const arr = type === 'call' ? chain.calls : chain.puts
  return arr?.find(c => c.strike === strike) ?? null
}

function scoreStrategy(netGreeks, targets, totalCost) {
  const keys = ['delta', 'gamma', 'vega', 'theta']
  let score = 0
  let targeted = 0

  for (const g of keys) {
    const target = targets[g]
    if (!target || target === 'ignore') continue
    targeted++
    const val = netGreeks[g]

    let alignment
    if (target === 'long')         alignment = val > 0 ? 1 : (val < 0 ? -1 : 0)
    else if (target === 'short')   alignment = val < 0 ? 1 : (val > 0 ? -1 : 0)
    else if (target === 'neutral') alignment = Math.abs(val) < 0.05 ? 1 : -0.5
    else alignment = 0

    score += alignment
  }

  if (targeted === 0) return 0
  return (score / targeted) / Math.max(Math.abs(totalCost), 1) * 1000
}

function computeRebalancingNote(netGreeks, legs, spotPrice) {
  const notes = []

  if (Math.abs(netGreeks.gamma) > 0.0001 && Math.abs(netGreeks.delta) < 0.15) {
    const deltaTol = 0.10
    const rebalanceMove = deltaTol / Math.abs(netGreeks.gamma)
    const rebalancePct  = (rebalanceMove / spotPrice * 100).toFixed(1)
    notes.push(
      `Delta drifts ~±${deltaTol} per $${Math.round(rebalanceMove).toLocaleString()} spot move. ` +
      `Consider re-hedging when spot moves ±${rebalancePct}% (~$${Math.round(rebalanceMove).toLocaleString()}).`
    )
  }

  const optionLegs = legs.filter(l => l.type !== 'future')
  if (optionLegs.length > 0) {
    const daysLeft = optionLegs.map(l => dte(l.expiry)).filter(d => d > 0)
    if (daysLeft.length > 0) {
      const nearDays = Math.min(...daysLeft)
      if (nearDays <= 14) {
        notes.push(`Near leg expires in ${Math.round(nearDays)} days — roll or close before expiry.`)
      }
    }
  }

  const longLegs  = optionLegs.filter(l => l.side === 'buy')
  const shortLegs = optionLegs.filter(l => l.side === 'sell')
  if (longLegs.length > 0 && shortLegs.length > 0) {
    const latestShort = Math.max(...shortLegs.map(l => new Date(l.expiry + 'T08:00:00Z').getTime()))
    const latestLong  = Math.max(...longLegs.map(l => new Date(l.expiry + 'T08:00:00Z').getTime()))
    if (latestShort < latestLong) {
      notes.push(`Short leg expires before long leg — vega exposure reverses after short leg expires.`)
    }
  }

  return notes.join(' ') || 'No special rebalancing required.'
}

// ─── Strategy Enumeration ─────────────────────────────────────────────────────

function strikeBuckets(chain, spotPrice, expiryStr) {
  const T = dte(expiryStr) / 365
  if (T <= 0) return null

  const allStrikes = Array.from(new Set([
    ...chain.calls.map(c => c.strike),
    ...chain.puts.map(p => p.strike),
  ])).sort((a, b) => a - b)
  if (!allStrikes.length) return null

  const atm = allStrikes.reduce((p, c) =>
    Math.abs(c - spotPrice) < Math.abs(p - spotPrice) ? c : p
  )

  const atmCall = chain.calls.find(c => c.strike === atm)
  const atmIV   = atmCall?.markVol || 0.7
  const sigma   = atmIV * Math.sqrt(T) * spotPrice

  const target = (n) => spotPrice + n * sigma
  const closest = (targetPrice) => allStrikes.reduce((p, c) =>
    Math.abs(c - targetPrice) < Math.abs(p - targetPrice) ? c : p
  )

  return {
    atm,
    otmCall1: closest(target(0.5)),
    otmCall2: closest(target(1.0)),
    otmCall3: closest(target(1.5)),
    otmCall4: closest(target(2.0)),
    otmPut1:  closest(target(-0.5)),
    otmPut2:  closest(target(-1.0)),
    otmPut3:  closest(target(-1.5)),
    otmPut4:  closest(target(-2.0)),
    itmCall1: closest(target(-0.5)),
    itmPut1:  closest(target(0.5)),
  }
}

function buildCandidate(name, legSpecs, chainByExpiry, spotPrice, exchanges) {
  const legs = []
  let totalCost = 0
  const netGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

  for (const spec of legSpecs) {
    if (spec.type === 'future') {
      const sign = spec.side === 'buy' ? 1 : -1
      legs.push({ ...spec, price: spotPrice, exchange: 'bybit' })
      netGreeks.delta += sign * spec.qty
      continue
    }

    const chain = chainByExpiry[spec.expiry]
    if (!chain) return null

    const contract = findContract(chain, spec.strike, spec.type)
    if (!contract) return null

    const { price, exchange } = bestExchange(contract, spec.side, exchanges)
    if (!price || !exchange) return null

    const feePrice = withFee(price, spec.side, exchange, spotPrice)
    const sign = spec.side === 'buy' ? 1 : -1

    legs.push({ ...spec, price: feePrice, exchange })

    if (spec.side === 'buy') totalCost += feePrice * spec.qty
    else totalCost -= feePrice * spec.qty

    netGreeks.delta += sign * (contract.delta || 0) * spec.qty
    netGreeks.gamma += sign * (contract.gamma || 0) * spec.qty
    netGreeks.theta += sign * (contract.theta || 0) * spec.qty
    netGreeks.vega  += sign * (contract.vega  || 0) * spec.qty
  }

  return { name, legs, netGreeks, totalCost }
}

function enumSingleExpiry(expiry, chain, spotPrice, maxLegs, exchanges) {
  const b = strikeBuckets(chain, spotPrice, expiry)
  if (!b) return []
  const candidates = []

  const add = (name, legSpecs) => {
    const c = buildCandidate(name, legSpecs, { [expiry]: chain }, spotPrice, exchanges)
    if (c) candidates.push(c)
  }

  if (maxLegs >= 2) {
    add('Straddle', [
      { side: 'buy', type: 'call', strike: b.atm, expiry, qty: 1 },
      { side: 'buy', type: 'put',  strike: b.atm, expiry, qty: 1 },
    ])

    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Strangle', [
        { side: 'buy', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'buy', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }

    if (b.otmCall2 !== b.otmCall1) {
      add('Wide Strangle', [
        { side: 'buy', type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'buy', type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }

    add('Short Straddle', [
      { side: 'sell', type: 'call', strike: b.atm, expiry, qty: 1 },
      { side: 'sell', type: 'put',  strike: b.atm, expiry, qty: 1 },
    ])

    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Short Strangle', [
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }

    // Vertical spreads
    if (b.otmCall1 !== b.atm) {
      add('Bull Call Spread', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
      ])
      add('Bear Call Spread', [
        { side: 'sell', type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall1, expiry, qty: 1 },
      ])
    }
    if (b.otmPut1 !== b.atm) {
      add('Bear Put Spread', [
        { side: 'buy',  type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1,  expiry, qty: 1 },
      ])
      add('Bull Put Spread', [
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'put', strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }

    // Risk reversal (bullish: long OTM call + short OTM put)
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Risk Reversal (Bullish)', [
        { side: 'buy',  type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
      add('Risk Reversal (Bearish)', [
        { side: 'buy',  type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
      ])
    }

    // Long Guts: buy ITM call + ITM put (intrinsic-heavy long vol)
    if (b.itmCall1 !== b.atm) {
      add('Long Guts', [
        { side: 'buy', type: 'call', strike: b.itmCall1, expiry, qty: 1 },
        { side: 'buy', type: 'put',  strike: b.itmPut1,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 3) {
    if (b.otmCall1 !== b.atm) {
      add('Ratio Call Spread', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
      ])
    }

    if (b.otmPut1 !== b.atm) {
      add('Ratio Put Spread', [
        { side: 'buy',  type: 'put', strike: b.atm,     expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1, expiry, qty: 2 },
      ])
    }

    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Call Butterfly', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
        { side: 'buy',  type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
      ])
    }

    if (b.otmPut1 !== b.atm && b.otmPut2 !== b.otmPut1) {
      add('Put Butterfly', [
        { side: 'buy',  type: 'put', strike: b.atm,     expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1, expiry, qty: 2 },
        { side: 'buy',  type: 'put', strike: b.otmPut2, expiry, qty: 1 },
      ])
    }

    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Jade Lizard', [
        { side: 'sell', type: 'put',  strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
      ])
    }

    if (b.itmCall1 !== b.atm && b.otmCall1 !== b.atm) {
      add('Call Ladder', [
        { side: 'buy',  type: 'call', strike: b.itmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
      ])
    }

    if (b.itmPut1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Put Ladder', [
        { side: 'buy',  type: 'put', strike: b.itmPut1, expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }

    // Backspreads: short 1 near-ATM, buy 2 further OTM — long gamma, convex
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Call Backspread', [
        { side: 'sell', type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall1, expiry, qty: 2 },
      ])
    }
    if (b.otmPut1 !== b.atm && b.otmPut2 !== b.otmPut1) {
      add('Put Backspread', [
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'put', strike: b.otmPut1,  expiry, qty: 2 },
      ])
    }

    // Short butterflies: bet on breakout, not pinning
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Short Call Butterfly', [
        { side: 'sell', type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall1, expiry, qty: 2 },
        { side: 'sell', type: 'call', strike: b.otmCall2, expiry, qty: 1 },
      ])
    }
    if (b.otmPut1 !== b.atm && b.otmPut2 !== b.otmPut1) {
      add('Short Put Butterfly', [
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'put', strike: b.otmPut1,  expiry, qty: 2 },
        { side: 'sell', type: 'put', strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }

    // Seagull: long OTM call + short lower put + short higher call (cheap directional)
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1 && b.otmPut1 !== b.atm) {
      add('Seagull (Bullish)', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
      ])
      add('Seagull (Bearish)', [
        { side: 'buy',  type: 'put',  strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 4) {
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm &&
        b.otmCall2 !== b.otmCall1 && b.otmPut2 !== b.otmPut1) {
      add('Iron Condor', [
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }

    if (b.otmCall1 !== b.atm && b.otmCall3 !== b.otmCall1) {
      add('Broken Wing Butterfly (Call)', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
        { side: 'buy',  type: 'call', strike: b.otmCall3,  expiry, qty: 1 },
      ])
    }

    if (b.otmCall2 !== b.atm && b.otmPut2 !== b.atm) {
      add('Iron Butterfly', [
        { side: 'buy',  type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.atm,       expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }

    // Reverse Iron Butterfly: long straddle + short wings (defined-risk long vol)
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Reverse Iron Butterfly', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }

    // Reverse Iron Condor: long call spread + long put spread (cheap breakout)
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm &&
        b.otmCall2 !== b.otmCall1 && b.otmPut2 !== b.otmPut1) {
      add('Reverse Iron Condor', [
        { side: 'buy',  type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 5) {
    if (b.otmCall3 !== b.otmCall2) {
      add('Call Condor', [
        { side: 'buy',  type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall3,  expiry, qty: 1 },
      ])
      add('Put Condor', [
        { side: 'buy',  type: 'put',  strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut3,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 6) {
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm &&
        b.otmCall2 !== b.otmCall1 && b.otmPut2 !== b.otmPut1) {
      add('Double Ratio Spread', [
        { side: 'buy',  type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,   expiry, qty: 2 },
        { side: 'buy',  type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,   expiry, qty: 1 },
      ])
    }
  }

  return candidates
}

function enumCalendars(expirations, chainByExpiry, spotPrice, maxLegs, exchanges) {
  if (maxLegs < 2) return []
  const candidates = []

  for (let i = 0; i < expirations.length - 1; i++) {
  for (let j = i + 1; j < expirations.length; j++) {
    const nearExp = expirations[i]
    const farExp  = expirations[j]
    const nearChain = chainByExpiry[nearExp]
    const farChain  = chainByExpiry[farExp]
    if (!nearChain || !farChain) continue

    const bNear = strikeBuckets(nearChain, spotPrice, nearExp)
    const bFar  = strikeBuckets(farChain,  spotPrice, farExp)
    if (!bNear || !bFar) continue

    const chains = { [nearExp]: nearChain, [farExp]: farChain }

    const add = (name, legSpecs) => {
      const c = buildCandidate(name, legSpecs, chains, spotPrice, exchanges)
      if (c) candidates.push(c)
    }

    add('Call Calendar', [
      { side: 'sell', type: 'call', strike: bNear.atm, expiry: nearExp, qty: 1 },
      { side: 'buy',  type: 'call', strike: bFar.atm,  expiry: farExp,  qty: 1 },
    ])

    add('Put Calendar', [
      { side: 'sell', type: 'put', strike: bNear.atm, expiry: nearExp, qty: 1 },
      { side: 'buy',  type: 'put', strike: bFar.atm,  expiry: farExp,  qty: 1 },
    ])

    if (bNear.otmCall1 !== bNear.atm) {
      add('Call Diagonal', [
        { side: 'sell', type: 'call', strike: bNear.otmCall1, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'call', strike: bFar.atm,       expiry: farExp,  qty: 1 },
      ])
    }

    if (bNear.otmPut1 !== bNear.atm) {
      add('Put Diagonal', [
        { side: 'sell', type: 'put', strike: bNear.otmPut1, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'put', strike: bFar.atm,      expiry: farExp,  qty: 1 },
      ])
    }

    if (maxLegs >= 4) {
      add('Double Calendar', [
        { side: 'sell', type: 'call', strike: bNear.atm, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'call', strike: bFar.atm,  expiry: farExp,  qty: 1 },
        { side: 'sell', type: 'put',  strike: bNear.atm, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'put',  strike: bFar.atm,  expiry: farExp,  qty: 1 },
      ])
    }
  }
  }

  return candidates
}

function addDeltaHedge(candidate, spotPrice, futures) {
  const netDelta = candidate.netGreeks.delta
  if (Math.abs(netDelta) < 0.02) return

  const perp = futures?.find(f => f.isPerp && f.markPrice > 0)
  if (!perp) return

  const side = netDelta > 0 ? 'sell' : 'buy'
  const qty  = Math.abs(netDelta)
  const price = perp.markPrice || spotPrice

  candidate.legs.push({
    side, type: 'future', strike: 0,
    expiry: 'perpetual', qty, price,
    exchange: perp.exchange || 'bybit',
  })
  candidate.netGreeks.delta += (side === 'buy' ? 1 : -1) * qty
}

export function runOptimizer(combinedOptionsData, spotPrice, futures, targets, maxCost, maxLegs, targetExpiry = null, exchanges = ['bybit', 'okx', 'deribit']) {
  if (!combinedOptionsData || !spotPrice) return []

  let expirations = futureExpirations(combinedOptionsData.expirations || [])

  // Filter to target expiry window if specified (±3 days tolerance)
  if (targetExpiry) {
    const targetTs = new Date(targetExpiry + 'T08:00:00Z').getTime()
    const WINDOW_MS = 3 * 86_400_000
    expirations = expirations.filter(exp => {
      const expTs = new Date(exp + 'T08:00:00Z').getTime()
      return Math.abs(expTs - targetTs) <= WINDOW_MS
    })
  }
  const chainByExpiry = combinedOptionsData.data || {}

  let candidates = []

  for (const expiry of expirations) {
    const chain = chainByExpiry[expiry]
    if (!chain?.calls?.length || !chain?.puts?.length) continue
    candidates.push(...enumSingleExpiry(expiry, chain, spotPrice, maxLegs, exchanges))
  }

  candidates.push(...enumCalendars(expirations, chainByExpiry, spotPrice, maxLegs, exchanges))

  if (targets.delta === 'neutral') {
    for (const c of candidates) {
      addDeltaHedge(c, spotPrice, futures)
    }
  }

  const scored = candidates
    .filter(c => {
      if (!c.legs.length) return false
      if (maxCost > 0 && c.totalCost > maxCost) return false
      return true
    })
    .map(c => ({
      ...c,
      score: scoreStrategy(c.netGreeks, targets, c.totalCost),
      rebalancingNote: computeRebalancingNote(c.netGreeks, c.legs, spotPrice),
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)

  const seen = new Set()
  const deduped = []
  for (const c of scored) {
    const key = `${c.name}|${c.legs.map(l => `${l.expiry}:${l.strike}:${l.type}:${l.side}`).join(',')}`
    if (!seen.has(key)) { seen.add(key); deduped.push(c) }
  }

  // Guarantee multi-expiry strategies appear: take top 10 overall, then inject
  // up to 5 best multi-expiry candidates not already present.
  const isMultiExpiry = (c) =>
    new Set(c.legs.filter(l => l.type !== 'future').map(l => l.expiry)).size > 1

  const top10 = deduped.slice(0, 10)
  const top10Keys = new Set(top10.map(c =>
    `${c.name}|${c.legs.map(l => `${l.expiry}:${l.strike}:${l.type}:${l.side}`).join(',')}`
  ))

  const bonusMulti = deduped
    .filter(c => isMultiExpiry(c))
    .filter(c => !top10Keys.has(
      `${c.name}|${c.legs.map(l => `${l.expiry}:${l.strike}:${l.type}:${l.side}`).join(',')}`
    ))
    .slice(0, 5)

  return [...top10, ...bonusMulti].sort((a, b) => b.score - a.score)
}
