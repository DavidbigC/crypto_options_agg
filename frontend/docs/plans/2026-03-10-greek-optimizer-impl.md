# Greek Optimizer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/optimizer` page where users pick Greek targets and receive ranked, concrete multi-leg trade recommendations with best-exchange routing and rebalancing notes.

**Architecture:** Backend `optimizer.js` receives pre-built combined options data (same pattern as `scanners.js`) and enumerates strategy templates across all strikes/expiries, scoring each against user targets. Frontend is a two-panel page (inputs left, result cards right) in the worktree at `~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer`.

**Tech Stack:** Node.js ESM backend, Next.js 14 + TypeScript frontend, Tailwind CSS, existing `Leg` type from `types/options.ts` for builder integration.

**Worktree:** `~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer`
All edits go in the worktree, not in the main working directory.

---

## Key Conventions (read before touching anything)

- **Backend**: ESM (`import`/`export`). All files in `backend/lib/` use named exports.
- **Frontend**: TypeScript strict mode. `@/` alias = `frontend/` root.
- **CSS classes**: Use existing `card`, `table-cell`, `table-header`, `price-positive`, `price-negative` from `globals.css`. Exchange badges: `B`=bybit blue, `O`=okx green, `D`=deribit violet — follow `EX_BADGE` from `lib/exchangeColors.ts`.
- **Greeks sign convention**: delta (0→1 calls, -1→0 puts), gamma (always +), theta (always −, $/day), vega (always +, $ per 1% IV).
- **Combined options data shape**: `{ spotPrice, expirations, data: { [expiry]: { calls: CombinedOptionContract[], puts: CombinedOptionContract[], forwardPrice } } }` where each contract has `prices: { bybit: {bid,ask}, okx: {bid,ask}, deribit: {bid,ask} }` plus `delta, gamma, theta, vega`.
- **Build check**: `cd frontend && npm run build` — must pass after every task.
- **Nav links** always open in new tab: `target="_blank" rel="noopener noreferrer"`.

---

## Task 1: Backend optimizer core — `backend/lib/optimizer.js`

**Files:**
- Create: `backend/lib/optimizer.js`

This is the heart of the feature. Follows the same pattern as `backend/lib/scanners.js` — receives pre-built optionsData and returns results.

**Step 1: Create the file with helpers**

```js
// backend/lib/optimizer.js
// Greek optimizer: enumerates multi-leg strategy templates against combined options data
// and scores each against user-supplied Greek targets.

// ─── Constants ───────────────────────────────────────────────────────────────

const EXCHANGES = ['bybit', 'okx', 'deribit']

const TAKER_FEE = 0.0003
const FEE_CAP = { bybit: 0.07, okx: 0.07, deribit: 0.125 }

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Filter to future expirations only (cutoff = T08:00:00Z) */
function futureExpirations(expirations) {
  const now = Date.now()
  return (expirations || []).filter(exp => new Date(exp + 'T08:00:00Z').getTime() > now)
}

/** Days to expiry from now */
function dte(expiry) {
  return Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)
}

/** Best ask across active exchanges for a combined contract (lowest ask wins for buy) */
function bestAsk(contract, spotPrice) {
  let best = 0
  for (const ex of EXCHANGES) {
    const raw = contract.prices?.[ex]?.ask || 0
    if (raw > 0 && (best === 0 || raw < best)) best = raw
  }
  return best
}

/** Best bid across active exchanges for a combined contract (highest bid wins for sell) */
function bestBid(contract, spotPrice) {
  let best = 0
  for (const ex of EXCHANGES) {
    const raw = contract.prices?.[ex]?.bid || 0
    if (raw > best) best = raw
  }
  return best
}

/** Exchange with the best price for a given side */
function bestExchange(contract, side) {
  let bestVal = 0
  let bestEx = null
  for (const ex of EXCHANGES) {
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

/** Apply taker fee to a price */
function withFee(price, side, exchange, spotPrice) {
  if (!price) return 0
  const cap = FEE_CAP[exchange] ?? 0.07
  const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
  return side === 'buy' ? price + fee : price - fee
}

/** Find contract in chain by strike and type */
function findContract(chain, strike, type) {
  const arr = type === 'call' ? chain.calls : chain.puts
  return arr?.find(c => c.strike === strike) ?? null
}

/**
 * Score a strategy against user targets.
 * Returns a numeric score; higher = better match.
 * Also divides by total cost to prefer cheaper strategies.
 */
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
    if (target === 'long')    alignment = val > 0 ? 1 : (val < 0 ? -1 : 0)
    else if (target === 'short')   alignment = val < 0 ? 1 : (val > 0 ? -1 : 0)
    else if (target === 'neutral') alignment = Math.abs(val) < 0.05 ? 1 : -0.5
    else alignment = 0

    score += alignment
  }

  if (targeted === 0 || totalCost <= 0) return 0
  // Normalise: score per targeted Greek, divided by cost (prefer efficiency)
  return (score / targeted) / totalCost * 1000
}

/**
 * Generate a static rebalancing note for a strategy.
 */
function computeRebalancingNote(netGreeks, legs, spotPrice) {
  const notes = []

  // Delta drift warning (only relevant if there's meaningful gamma)
  if (Math.abs(netGreeks.gamma) > 0.0001 && Math.abs(netGreeks.delta) < 0.15) {
    const deltaTol = 0.10
    const rebalanceMove = deltaTol / Math.abs(netGreeks.gamma)
    const rebalancePct  = (rebalanceMove / spotPrice * 100).toFixed(1)
    notes.push(
      `Delta drifts ~±${deltaTol} per $${Math.round(rebalanceMove).toLocaleString()} spot move. ` +
      `Consider re-hedging when spot moves ±${rebalancePct}% (~$${Math.round(rebalanceMove).toLocaleString()}).`
    )
  }

  // Near-dated roll warning
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

  // Calendar/diagonal: short leg expires before long → vega reversal
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
```

**Step 2: Add strategy template enumeration**

Append to the same file:

```js
// ─── Strategy Enumeration ─────────────────────────────────────────────────────

/**
 * Given an expiry's chain and the spot price, return an array of strike
 * candidates bucketed by distance from spot (in multiples of 1σ).
 * σ = ATM_IV × √(T/365) × spot
 */
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

  // Estimate σ from ATM call's markVol
  const atmCall = chain.calls.find(c => c.strike === atm)
  const atmIV   = atmCall?.markVol || 0.7 // fallback 70%
  const sigma   = atmIV * Math.sqrt(T) * spotPrice

  // Find strikes closest to ATM + n*σ for n = 0, ±0.5, ±1, ±1.5, ±2
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

/**
 * Build a candidate strategy from a list of leg specs:
 *   [ { side, type, strike, expiry, qty } ]
 * Returns null if any leg has no price on any exchange.
 */
function buildCandidate(name, legSpecs, chainByExpiry, spotPrice) {
  const legs = []
  let totalCost = 0
  const netGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

  for (const spec of legSpecs) {
    if (spec.type === 'future') {
      // Futures leg for delta hedge — price = spotPrice (perp approximation)
      const sign = spec.side === 'buy' ? 1 : -1
      legs.push({ ...spec, price: spotPrice, exchange: 'bybit' })
      netGreeks.delta += sign * spec.qty
      // futures have no gamma/theta/vega
      continue
    }

    const chain = chainByExpiry[spec.expiry]
    if (!chain) return null

    const contract = findContract(chain, spec.strike, spec.type)
    if (!contract) return null

    const { price, exchange } = bestExchange(contract, spec.side)
    if (!price || !exchange) return null

    const feePrice = withFee(price, spec.side, exchange, spotPrice)
    const sign = spec.side === 'buy' ? 1 : -1

    legs.push({ ...spec, price: feePrice, exchange })

    if (spec.side === 'buy') totalCost += feePrice * spec.qty
    else totalCost -= feePrice * spec.qty   // credit received

    netGreeks.delta += sign * (contract.delta || 0) * spec.qty
    netGreeks.gamma += sign * (contract.gamma || 0) * spec.qty
    netGreeks.theta += sign * (contract.theta || 0) * spec.qty
    netGreeks.vega  += sign * (contract.vega  || 0) * spec.qty
  }

  return { name, legs, netGreeks, totalCost }
}

/**
 * Enumerate all strategy templates for a single expiry.
 * Returns array of raw candidates (unscored).
 */
function enumSingleExpiry(expiry, chain, spotPrice, maxLegs) {
  const b = strikeBuckets(chain, spotPrice, expiry)
  if (!b) return []
  const candidates = []

  const add = (name, legSpecs, chainByExpiry) => {
    const c = buildCandidate(name, legSpecs, chainByExpiry, spotPrice)
    if (c) candidates.push(c)
  }

  const chains = { [expiry]: chain }

  // 2-leg strategies
  if (maxLegs >= 2) {
    // Straddle
    add('Straddle', [
      { side: 'buy', type: 'call', strike: b.atm, expiry, qty: 1 },
      { side: 'buy', type: 'put',  strike: b.atm, expiry, qty: 1 },
    ], chains)

    // Strangle (0.5σ)
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Strangle', [
        { side: 'buy', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'buy', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ], chains)
    }

    // Wide strangle (1σ)
    if (b.otmCall2 !== b.otmCall1) {
      add('Wide Strangle', [
        { side: 'buy', type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'buy', type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ], chains)
    }

    // Short straddle (credit)
    add('Short Straddle', [
      { side: 'sell', type: 'call', strike: b.atm, expiry, qty: 1 },
      { side: 'sell', type: 'put',  strike: b.atm, expiry, qty: 1 },
    ], chains)

    // Short strangle
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Short Strangle', [
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ], chains)
    }
  }

  // 3-leg strategies
  if (maxLegs >= 3) {
    // Ratio call spread (buy 1 ATM call, sell 2 OTM calls)
    if (b.otmCall1 !== b.atm) {
      add('Ratio Call Spread', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
      ], chains)
    }

    // Ratio put spread
    if (b.otmPut1 !== b.atm) {
      add('Ratio Put Spread', [
        { side: 'buy',  type: 'put', strike: b.atm,     expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1, expiry, qty: 2 },
      ], chains)
    }

    // Call butterfly
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Call Butterfly', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
        { side: 'buy',  type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
      ], chains)
    }

    // Put butterfly
    if (b.otmPut1 !== b.atm && b.otmPut2 !== b.otmPut1) {
      add('Put Butterfly', [
        { side: 'buy',  type: 'put', strike: b.atm,     expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1, expiry, qty: 2 },
        { side: 'buy',  type: 'put', strike: b.otmPut2, expiry, qty: 1 },
      ], chains)
    }

    // Jade lizard (sell ATM put + sell OTM call + buy further OTM call)
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1) {
      add('Jade Lizard', [
        { side: 'sell', type: 'put',  strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
      ], chains)
    }

    // Call ladder (buy ITM, sell ATM, sell OTM)
    if (b.itmCall1 !== b.atm && b.otmCall1 !== b.atm) {
      add('Call Ladder', [
        { side: 'buy',  type: 'call', strike: b.itmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
      ], chains)
    }

    // Put ladder
    if (b.itmPut1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Put Ladder', [
        { side: 'buy',  type: 'put', strike: b.itmPut1, expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1,  expiry, qty: 1 },
      ], chains)
    }
  }

  // 4-leg strategies
  if (maxLegs >= 4) {
    // Iron condor
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm &&
        b.otmCall2 !== b.otmCall1 && b.otmPut2 !== b.otmPut1) {
      add('Iron Condor', [
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ], chains)
    }

    // Broken wing butterfly (call)
    if (b.otmCall1 !== b.atm && b.otmCall3 !== b.otmCall1) {
      add('Broken Wing Butterfly (Call)', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 2 },
        { side: 'buy',  type: 'call', strike: b.otmCall3,  expiry, qty: 1 },
      ], chains)
    }

    // Iron butterfly
    if (b.otmCall2 !== b.atm && b.otmPut2 !== b.atm) {
      add('Iron Butterfly', [
        { side: 'buy',  type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.atm,       expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ], chains)
    }
  }

  // 5-leg strategies
  if (maxLegs >= 5) {
    // Call condor (4 calls at different strikes)
    if (b.otmCall3 !== b.otmCall2) {
      add('Call Condor', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
        { side: 'buy',  type: 'call', strike: b.otmCall3,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.atm,       expiry, qty: 1 }, // add put for delta neutral
      ], chains)
    }
  }

  // 6-leg strategies
  if (maxLegs >= 6) {
    // Christmas tree (call): buy 1 ATM, sell 3 at different OTM strikes
    if (b.otmCall1 !== b.atm && b.otmCall2 !== b.otmCall1 && b.otmCall3 !== b.otmCall2) {
      add('Christmas Tree (Call)', [
        { side: 'buy',  type: 'call', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall1,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall2,  expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.otmCall3,  expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.atm,       expiry, qty: 1 }, // delta hedge via put
        { side: 'sell', type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ], chains)
    }
  }

  return candidates
}

/**
 * Enumerate calendar/diagonal templates across expiry pairs.
 */
function enumCalendars(expirations, chainByExpiry, spotPrice, maxLegs) {
  if (maxLegs < 2) return []
  const candidates = []

  for (let i = 0; i < expirations.length - 1; i++) {
    const nearExp = expirations[i]
    const farExp  = expirations[i + 1]
    const nearChain = chainByExpiry[nearExp]
    const farChain  = chainByExpiry[farExp]
    if (!nearChain || !farChain) continue

    const bNear = strikeBuckets(nearChain, spotPrice, nearExp)
    const bFar  = strikeBuckets(farChain,  spotPrice, farExp)
    if (!bNear || !bFar) continue

    const chains = { [nearExp]: nearChain, [farExp]: farChain }

    const add = (name, legSpecs) => {
      const c = buildCandidate(name, legSpecs, chains, spotPrice)
      if (c) candidates.push(c)
    }

    // Call calendar (ATM)
    add('Call Calendar', [
      { side: 'sell', type: 'call', strike: bNear.atm, expiry: nearExp, qty: 1 },
      { side: 'buy',  type: 'call', strike: bFar.atm,  expiry: farExp,  qty: 1 },
    ])

    // Put calendar (ATM)
    add('Put Calendar', [
      { side: 'sell', type: 'put', strike: bNear.atm, expiry: nearExp, qty: 1 },
      { side: 'buy',  type: 'put', strike: bFar.atm,  expiry: farExp,  qty: 1 },
    ])

    // Diagonal (sell near OTM call, buy far ATM call)
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

    // Double calendar (call + put calendar, same expiries)
    if (maxLegs >= 4) {
      add('Double Calendar', [
        { side: 'sell', type: 'call', strike: bNear.atm, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'call', strike: bFar.atm,  expiry: farExp,  qty: 1 },
        { side: 'sell', type: 'put',  strike: bNear.atm, expiry: nearExp, qty: 1 },
        { side: 'buy',  type: 'put',  strike: bFar.atm,  expiry: farExp,  qty: 1 },
      ])
    }
  }

  return candidates
}
```

**Step 3: Add delta-hedge insertion and main export**

Append to the same file:

```js
/**
 * Add a futures delta-hedge leg to neutralize net delta.
 * Modifies candidate.legs in place; returns updated netGreeks.
 */
function addDeltaHedge(candidate, spotPrice, futures) {
  const netDelta = candidate.netGreeks.delta
  if (Math.abs(netDelta) < 0.02) return // already near-neutral

  // Find best perp/futures instrument
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

/**
 * Main optimizer entry point.
 *
 * @param {object} combinedOptionsData - output of buildCombinedResponse()
 * @param {number} spotPrice
 * @param {Array}  futures             - from futuresCache[coin]
 * @param {object} targets             - { delta, gamma, vega, theta } each 'long'|'short'|'neutral'|'ignore'
 * @param {number} maxCost             - max premium in USD (0 = no limit)
 * @param {number} maxLegs             - 2–6
 * @returns {Array} top 10 results sorted by score descending
 */
export function runOptimizer(combinedOptionsData, spotPrice, futures, targets, maxCost, maxLegs) {
  if (!combinedOptionsData || !spotPrice) return []

  const expirations   = futureExpirations(combinedOptionsData.expirations || [])
  const chainByExpiry = combinedOptionsData.data || {}

  // Collect all candidates
  let candidates = []

  // Single-expiry strategies
  for (const expiry of expirations) {
    const chain = chainByExpiry[expiry]
    if (!chain?.calls?.length || !chain?.puts?.length) continue
    candidates.push(...enumSingleExpiry(expiry, chain, spotPrice, maxLegs))
  }

  // Calendar / diagonal strategies
  candidates.push(...enumCalendars(expirations, chainByExpiry, futures, spotPrice, maxLegs))

  // Add delta hedge if targets.delta === 'neutral'
  if (targets.delta === 'neutral') {
    for (const c of candidates) {
      addDeltaHedge(c, spotPrice, futures)
    }
  }

  // Score and filter
  const scored = candidates
    .filter(c => {
      if (!c.legs.length) return false
      if (maxCost > 0 && c.totalCost > maxCost) return false
      return true
    })
    .map(c => ({
      ...c,
      score: scoreStrategy(c.netGreeks, targets, Math.max(c.totalCost, 1)),
      rebalancingNote: computeRebalancingNote(c.netGreeks, c.legs, spotPrice),
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)

  // Deduplicate by name+expiry (keep best score)
  const seen = new Set()
  const deduped = []
  for (const c of scored) {
    const key = `${c.name}|${c.legs.map(l => `${l.expiry}:${l.strike}:${l.type}:${l.side}`).join(',')}`
    if (!seen.has(key)) { seen.add(key); deduped.push(c) }
  }

  return deduped.slice(0, 10)
}
```

**Step 4: Fix the calendar enumeration call** (it passes `futures` incorrectly)

In `enumCalendars`, the function signature doesn't take `futures`. Fix the call in `runOptimizer`:
```js
candidates.push(...enumCalendars(expirations, chainByExpiry, spotPrice, maxLegs))
```
Remove `futures` from the call — `enumCalendars` doesn't need it.

**Step 5: Verify file is valid ESM**
```bash
cd ~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer
node --input-type=module < backend/lib/optimizer.js
```
Expected: no output (no top-level code to run), no errors.

**Step 6: Commit**
```bash
cd ~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer
git add backend/lib/optimizer.js
git commit -m "feat: add optimizer core — strategy enumeration, scoring, rebalancing notes"
```

---

## Task 2: Backend endpoint — `backend/server.js`

**Files:**
- Modify: `backend/server.js`

**Step 1: Add import at top of server.js** (after existing imports)

Find the line:
```js
import { scannerCache, updateScannerCache, computeGammaRows, computeVegaRows } from './lib/scanners.js'
```
Add after it:
```js
import { runOptimizer } from './lib/optimizer.js'
```

**Step 2: Add the POST endpoint**

Find `app.get('/api/futures/:coin'` and add the optimizer endpoint just before it:

```js
app.post('/api/optimizer/:coin', (req, res) => {
  const coin    = req.params.coin.toUpperCase()
  const { targets = {}, maxCost = 0, maxLegs = 4 } = req.body

  const combined = buildCombinedResponse(coin)
  if (!combined) return res.json([])

  const spotPrice = combined.spotPrice || 0
  const futures   = futuresCache[coin] ?? []

  try {
    const results = runOptimizer(combined, spotPrice, futures, targets, maxCost, Math.min(maxLegs, 6))
    res.json(results)
  } catch (err) {
    console.error('optimizer error:', err)
    res.status(500).json({ error: err.message })
  }
})
```

**Step 3: Test the endpoint manually**
```bash
curl -s -X POST http://localhost:3500/api/optimizer/BTC \
  -H 'Content-Type: application/json' \
  -d '{"targets":{"delta":"neutral","gamma":"long","vega":"ignore","theta":"ignore"},"maxCost":5000,"maxLegs":4}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); console.log(r.length, 'results'); console.log(r[0]?.name, r[0]?.score?.toFixed(2))"
```
Expected: `10 results` (or fewer if data sparse), strategy name and score printed.

**Step 4: Commit**
```bash
git add backend/server.js
git commit -m "feat: add POST /api/optimizer/:coin endpoint"
```

---

## Task 3: Frontend TypeScript types — `frontend/types/optimizer.ts`

**Files:**
- Create: `frontend/types/optimizer.ts`

**Step 1: Create file**

```ts
// frontend/types/optimizer.ts

export type GreekTarget = 'long' | 'short' | 'neutral' | 'ignore'

export interface OptimizerTargets {
  delta: GreekTarget
  gamma: GreekTarget
  vega:  GreekTarget
  theta: GreekTarget
}

export interface OptimizerLeg {
  side:     'buy' | 'sell'
  type:     'call' | 'put' | 'future'
  strike:   number
  expiry:   string      // 'YYYY-MM-DD' or 'perpetual'
  qty:      number
  price:    number      // USD, fee-inclusive
  exchange: string | null
}

export interface OptimizerNetGreeks {
  delta: number
  gamma: number
  theta: number
  vega:  number
}

export interface OptimizerResult {
  name:             string
  legs:             OptimizerLeg[]
  netGreeks:        OptimizerNetGreeks
  totalCost:        number
  score:            number
  rebalancingNote:  string
}

export interface OptimizerRequest {
  targets:  OptimizerTargets
  maxCost:  number
  maxLegs:  number
}
```

**Step 2: Build check**
```bash
cd ~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer/frontend
npm run build 2>&1 | tail -5
```
Expected: build passes.

**Step 3: Commit**
```bash
git add frontend/types/optimizer.ts
git commit -m "feat: add OptimizerResult TypeScript types"
```

---

## Task 4: GreekBar component — `frontend/components/optimizer/GreekBar.tsx`

**Files:**
- Create: `frontend/components/optimizer/GreekBar.tsx`

This is a visual bar showing how long/short each Greek is, with a target indicator.

**Step 1: Create component**

```tsx
// frontend/components/optimizer/GreekBar.tsx
import { GreekTarget } from '@/types/optimizer'
import classNames from 'classnames'

interface GreekBarProps {
  label:  string   // e.g. 'Γ'
  value:  number
  target: GreekTarget
  unit?:  string   // e.g. '$/day', '' for dimensionless
  formatValue?: (v: number) => string
}

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (Math.abs(v) >= 1)    return v.toFixed(2)
  return v.toFixed(4)
}

export default function GreekBar({ label, value, target, unit = '', formatValue = defaultFormat }: GreekBarProps) {
  const sign = value > 0 ? 'long' : value < 0 ? 'short' : 'neutral'

  const targetMet =
    (target === 'long'    && value > 0) ||
    (target === 'short'   && value < 0) ||
    (target === 'neutral' && Math.abs(value) < 0.05) ||
    target === 'ignore'

  // Bar width: scale to max 100% using log scale for large values
  const barWidth = Math.min(100, Math.abs(value) > 0
    ? Math.min(100, (Math.log10(Math.abs(value) + 1) / 3) * 100)
    : 0
  )

  const barColor = sign === 'long'
    ? 'bg-emerald-500'
    : sign === 'short'
    ? 'bg-rose-500'
    : 'bg-ink-3'

  return (
    <div className="flex items-center gap-2 text-[11px]">
      {/* Greek label */}
      <span className="w-4 text-ink-2 font-medium shrink-0">{label}</span>

      {/* Bar */}
      <div className="flex-1 h-1.5 bg-subtle rounded-full overflow-hidden">
        <div
          className={classNames('h-full rounded-full transition-all', barColor)}
          style={{ width: `${barWidth}%` }}
        />
      </div>

      {/* Value */}
      <span className={classNames('w-20 text-right tabular-nums', {
        'text-emerald-600 dark:text-emerald-400': sign === 'long',
        'text-rose-600 dark:text-rose-400': sign === 'short',
        'text-ink-3': sign === 'neutral',
      })}>
        {value > 0 ? '+' : ''}{formatValue(value)}{unit}
      </span>

      {/* Target indicator */}
      <span className={classNames('w-20 text-[10px]', targetMet ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500')}>
        {target === 'ignore' ? '—' : targetMet ? `✓ ${target}` : `✗ ${target}`}
      </span>
    </div>
  )
}
```

**Step 2: Build check**
```bash
npm run build 2>&1 | tail -5
```

**Step 3: Commit**
```bash
git add frontend/components/optimizer/GreekBar.tsx
git commit -m "feat: add GreekBar component for Greek visualization"
```

---

## Task 5: ResultCard component — `frontend/components/optimizer/ResultCard.tsx`

**Files:**
- Create: `frontend/components/optimizer/ResultCard.tsx`

**Step 1: Create component**

```tsx
// frontend/components/optimizer/ResultCard.tsx
'use client'

import { OptimizerResult, OptimizerTargets } from '@/types/optimizer'
import GreekBar from './GreekBar'
import classNames from 'classnames'

interface ResultCardProps {
  result:  OptimizerResult
  targets: OptimizerTargets
  rank:    number
  coin:    string
  spotPrice: number
}

const SIDE_COLOR: Record<string, string> = {
  buy:  'text-emerald-600 dark:text-emerald-400',
  sell: 'text-rose-600 dark:text-rose-400',
}

const TYPE_LABEL: Record<string, string> = {
  call:   'Call',
  put:    'Put',
  future: 'Perp/Fut',
}

const EX_BADGE: Record<string, string> = {
  bybit:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  okx:     'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  deribit: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
  bybit_perp: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
}

function fmtUSD(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(2)}k` : `$${v.toFixed(0)}`
}

function fmtExpiry(exp: string): string {
  if (exp === 'perpetual') return 'Perp'
  const d = new Date(exp + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export default function ResultCard({ result, targets, rank, coin, spotPrice }: ResultCardProps) {
  const { name, legs, netGreeks, totalCost, score, rebalancingNote } = result

  const handleLoadInBuilder = () => {
    // Store legs in localStorage; builder reads on mount
    localStorage.setItem('optimizer_import', JSON.stringify({
      coin,
      spotPrice,
      legs: legs.map((l, i) => ({
        id: `opt-${i}`,
        exchange: l.exchange ?? 'bybit',
        coin,
        symbol: l.type === 'future'
          ? `${coin}-PERP`
          : `${coin}-${l.expiry}-${l.strike}-${l.type.toUpperCase()[0]}`,
        expiry: l.expiry,
        strike: l.strike,
        type: l.type,
        side: l.side,
        qty: l.qty,
        entryPrice: l.price,
        markVol: 0,
        contractSize: 1,
        enabled: true,
      })),
    }))
    window.open('/builder', '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="card space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-ink-3 w-5">#{rank}</span>
          <span className="text-sm font-semibold text-ink">{name}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-ink-2">Score <span className="text-ink font-medium">{score.toFixed(1)}</span></span>
          <span className={classNames('font-medium', totalCost >= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
            {totalCost >= 0 ? `Cost ${fmtUSD(totalCost)}` : `Credit ${fmtUSD(-totalCost)}`}
          </span>
        </div>
      </div>

      {/* Legs table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-rim text-ink-3">
              <th className="text-left py-1 pr-3 font-medium">Side</th>
              <th className="text-left py-1 pr-3 font-medium">Type</th>
              <th className="text-right py-1 pr-3 font-medium">Strike</th>
              <th className="text-left py-1 pr-3 font-medium">Expiry</th>
              <th className="text-left py-1 pr-3 font-medium">Exchange</th>
              <th className="text-right py-1 pr-3 font-medium">Price</th>
              <th className="text-right py-1 font-medium">Qty</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={i} className="border-b border-rim/50 last:border-0">
                <td className={classNames('py-1 pr-3 font-medium capitalize', SIDE_COLOR[leg.side])}>
                  {leg.side}
                </td>
                <td className="py-1 pr-3 text-ink">{TYPE_LABEL[leg.type] ?? leg.type}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-ink">
                  {leg.type === 'future' ? '—' : leg.strike.toLocaleString()}
                </td>
                <td className="py-1 pr-3 text-ink">{fmtExpiry(leg.expiry)}</td>
                <td className="py-1 pr-3">
                  {leg.exchange && (
                    <span className={classNames('px-1.5 py-0.5 rounded text-[10px] font-medium', EX_BADGE[leg.exchange] ?? '')}>
                      {leg.exchange.charAt(0).toUpperCase()}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-ink">
                  {leg.type === 'future' ? '—' : fmtUSD(leg.price)}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {leg.qty.toFixed(leg.type === 'future' ? 3 : 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Greek bars */}
      <div className="space-y-1.5 py-1 border-t border-rim">
        <GreekBar label="Δ" value={netGreeks.delta} target={targets.delta} formatValue={v => v.toFixed(3)} />
        <GreekBar label="Γ" value={netGreeks.gamma} target={targets.gamma} formatValue={v => v.toFixed(5)} />
        <GreekBar label="ν" value={netGreeks.vega}  target={targets.vega}  unit="/1%" formatValue={v => `$${v.toFixed(0)}`} />
        <GreekBar label="Θ" value={netGreeks.theta} target={targets.theta} unit="/day" formatValue={v => `$${v.toFixed(0)}`} />
      </div>

      {/* Rebalancing note */}
      {rebalancingNote && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded p-2 border border-amber-200 dark:border-amber-800">
          ⚠ {rebalancingNote}
        </div>
      )}

      {/* Load in Builder */}
      <div className="flex justify-end pt-1">
        <button
          onClick={handleLoadInBuilder}
          className="px-3 py-1 text-[11px] font-medium rounded border border-rim text-ink-2 hover:text-ink hover:border-ink-3 transition-colors"
        >
          Load in Builder →
        </button>
      </div>
    </div>
  )
}
```

**Step 2: Build check + commit**
```bash
npm run build 2>&1 | tail -5
git add frontend/components/optimizer/
git commit -m "feat: add ResultCard and GreekBar optimizer components"
```

---

## Task 6: TargetInputs component — `frontend/components/optimizer/TargetInputs.tsx`

**Files:**
- Create: `frontend/components/optimizer/TargetInputs.tsx`

**Step 1: Create component**

```tsx
// frontend/components/optimizer/TargetInputs.tsx
'use client'

import { OptimizerTargets, GreekTarget } from '@/types/optimizer'
import classNames from 'classnames'

interface TargetInputsProps {
  coin:     'BTC' | 'ETH' | 'SOL'
  targets:  OptimizerTargets
  maxCost:  number
  maxLegs:  number
  loading:  boolean
  onCoinChange:    (c: 'BTC' | 'ETH' | 'SOL') => void
  onTargetChange:  (greek: keyof OptimizerTargets, val: GreekTarget) => void
  onMaxCostChange: (v: number) => void
  onMaxLegsChange: (v: number) => void
  onRun:           () => void
}

const GREEK_OPTIONS: GreekTarget[] = ['long', 'short', 'neutral', 'ignore']
const GREEK_ROWS: { key: keyof OptimizerTargets; label: string; symbol: string; description: string }[] = [
  { key: 'delta', symbol: 'Δ', label: 'Delta', description: 'Directional exposure to spot price' },
  { key: 'gamma', symbol: 'Γ', label: 'Gamma', description: 'Rate of delta change — convexity profit from large moves' },
  { key: 'vega',  symbol: 'ν', label: 'Vega',  description: 'Sensitivity to IV changes — profit from vol expansion' },
  { key: 'theta', symbol: 'Θ', label: 'Theta', description: 'Time decay — short theta = collecting premium daily' },
]

function TargetButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const colorMap: Record<string, string> = {
    long:    active ? 'bg-emerald-600 text-white border-emerald-600' : 'text-ink-2 border-rim hover:border-ink-3',
    short:   active ? 'bg-rose-600 text-white border-rose-600'       : 'text-ink-2 border-rim hover:border-ink-3',
    neutral: active ? 'bg-blue-600 text-white border-blue-600'       : 'text-ink-2 border-rim hover:border-ink-3',
    ignore:  active ? 'bg-ink-3 text-white border-ink-3'             : 'text-ink-3 border-rim hover:border-ink-3',
  }
  return (
    <button
      onClick={onClick}
      className={classNames(
        'px-2 py-0.5 rounded border text-[11px] font-medium transition-colors capitalize',
        colorMap[label] ?? ''
      )}
    >
      {label}
    </button>
  )
}

const COINS = ['BTC', 'ETH', 'SOL'] as const
const LEG_OPTIONS = [2, 3, 4, 5, 6]

export default function TargetInputs({
  coin, targets, maxCost, maxLegs, loading,
  onCoinChange, onTargetChange, onMaxCostChange, onMaxLegsChange, onRun,
}: TargetInputsProps) {
  return (
    <div className="card space-y-4">
      <h2 className="text-sm font-semibold text-ink">Greek Optimizer</h2>

      {/* Coin selector */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">Coin</label>
        <div className="flex gap-1">
          {COINS.map(c => (
            <button
              key={c}
              onClick={() => onCoinChange(c)}
              className={classNames(
                'px-3 py-1 rounded text-xs font-medium transition-colors border',
                coin === c ? 'bg-card text-ink border-ink-3 shadow-sm' : 'text-ink-2 border-rim hover:border-ink-3'
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Greek targets */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-2">Greek Targets</label>
        <div className="space-y-2">
          {GREEK_ROWS.map(({ key, symbol, label, description }) => (
            <div key={key}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[12px] font-medium text-ink w-5">{symbol}</span>
                <span className="text-[11px] text-ink-2">{label}</span>
                <span className="text-[10px] text-ink-3 hidden sm:inline">— {description}</span>
              </div>
              <div className="flex gap-1 ml-7">
                {GREEK_OPTIONS.map(opt => (
                  <TargetButton
                    key={opt}
                    label={opt}
                    active={targets[key] === opt}
                    onClick={() => onTargetChange(key, opt)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Max cost */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">
          Max Premium (USD) <span className="text-ink-3">{maxCost === 0 ? '— no limit' : ''}</span>
        </label>
        <input
          type="number"
          min={0}
          step={500}
          value={maxCost || ''}
          placeholder="No limit"
          onChange={e => onMaxCostChange(parseFloat(e.target.value) || 0)}
          className="w-full px-2.5 py-1.5 text-sm rounded border border-rim bg-card text-ink focus:outline-none focus:border-ink-3"
        />
      </div>

      {/* Max legs */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">Max Legs</label>
        <div className="flex gap-1">
          {LEG_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => onMaxLegsChange(n)}
              className={classNames(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors border',
                maxLegs === n ? 'bg-card text-ink border-ink-3 shadow-sm' : 'text-ink-2 border-rim hover:border-ink-3'
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Run button */}
      <button
        onClick={onRun}
        disabled={loading}
        className={classNames(
          'w-full py-2 rounded text-sm font-semibold transition-colors',
          loading
            ? 'bg-ink-3 text-white cursor-not-allowed'
            : 'bg-tone text-white hover:bg-amber-600'
        )}
      >
        {loading ? 'Searching…' : 'Find Strategies'}
      </button>
    </div>
  )
}
```

**Step 2: Build check + commit**
```bash
npm run build 2>&1 | tail -5
git add frontend/components/optimizer/TargetInputs.tsx
git commit -m "feat: add TargetInputs optimizer left-panel component"
```

---

## Task 7: Optimizer page — `frontend/app/optimizer/page.tsx`

**Files:**
- Create: `frontend/app/optimizer/page.tsx`

**Step 1: Create the page**

```tsx
// frontend/app/optimizer/page.tsx
'use client'

import { useState } from 'react'
import Header from '@/components/Header'
import TargetInputs from '@/components/optimizer/TargetInputs'
import ResultCard from '@/components/optimizer/ResultCard'
import { OptimizerTargets, OptimizerResult, GreekTarget } from '@/types/optimizer'
import { Exchange } from '@/types/options'

const DEFAULT_TARGETS: OptimizerTargets = {
  delta: 'neutral',
  gamma: 'long',
  vega:  'ignore',
  theta: 'ignore',
}

export default function OptimizerPage() {
  const [coin, setCoin]       = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [targets, setTargets] = useState<OptimizerTargets>(DEFAULT_TARGETS)
  const [maxCost, setMaxCost] = useState(0)
  const [maxLegs, setMaxLegs] = useState(4)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<OptimizerResult[]>([])
  const [error, setError]     = useState<string | null>(null)
  const [spotPrice, setSpotPrice] = useState(0)

  const handleTargetChange = (greek: keyof OptimizerTargets, val: GreekTarget) => {
    setTargets(prev => ({ ...prev, [greek]: val }))
  }

  const handleRun = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`http://localhost:3500/api/optimizer/${coin}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets, maxCost, maxLegs }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data: OptimizerResult[] = await res.json()
      setResults(data)
      if (data.length === 0) setError('No strategies found matching your targets. Try relaxing constraints.')
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  // Header requires exchange props — use a no-op for optimizer page
  const noopExchangeChange = () => {}

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={'bybit' as Exchange} onExchangeChange={noopExchangeChange} />

      <main className="container mx-auto px-4 py-4">
        <div className="flex gap-4 items-start">
          {/* Left panel — fixed width inputs */}
          <div className="w-72 shrink-0">
            <TargetInputs
              coin={coin}
              targets={targets}
              maxCost={maxCost}
              maxLegs={maxLegs}
              loading={loading}
              onCoinChange={setCoin}
              onTargetChange={handleTargetChange}
              onMaxCostChange={setMaxCost}
              onMaxLegsChange={setMaxLegs}
              onRun={handleRun}
            />
          </div>

          {/* Right panel — results */}
          <div className="flex-1 min-w-0 space-y-3">
            {!loading && results.length === 0 && !error && (
              <div className="card flex items-center justify-center h-48">
                <p className="text-ink-2 text-sm">Set your Greek targets and click Find Strategies.</p>
              </div>
            )}

            {loading && (
              <div className="card flex items-center justify-center h-48">
                <p className="text-ink-2 text-sm">Searching strategies…</p>
              </div>
            )}

            {error && (
              <div className="card text-sm text-rose-600 dark:text-rose-400 p-4">{error}</div>
            )}

            {!loading && results.map((r, i) => (
              <ResultCard
                key={`${r.name}-${i}`}
                result={r}
                targets={targets}
                rank={i + 1}
                coin={coin}
                spotPrice={spotPrice}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
```

**Step 2: Build check**
```bash
npm run build 2>&1 | tail -5
```
Expected: passes.

**Step 3: Commit**
```bash
git add frontend/app/optimizer/
git commit -m "feat: add /optimizer page with two-panel layout"
```

---

## Task 8: Header nav link + builder import

**Files:**
- Modify: `frontend/components/Header.tsx`
- Modify: `frontend/app/builder/page.tsx`

### Part A — Header nav link

**Step 1: Add Optimizer link to Header.tsx**

Find the existing nav links section:
```tsx
<a href="/analysis" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
  Analysis
</a>
<a href="/builder" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
  Strategy Builder
</a>
```

Add the Optimizer link between Analysis and Strategy Builder:
```tsx
<a href="/optimizer" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
  Optimizer
</a>
```

### Part B — Builder import from localStorage

The optimizer's "Load in Builder" button writes to `localStorage.optimizer_import` and opens `/builder`. The builder needs to read it on mount.

**Step 2: Read the builder page**

Read `frontend/app/builder/page.tsx` fully to find where `useEffect` and initial state setup happens.

**Step 3: Add import useEffect**

In `builder/page.tsx`, find the existing `useEffect` hooks. Add a new one at the top of the component (after state declarations) that runs once on mount:

```tsx
// Import legs from optimizer if available
useEffect(() => {
  try {
    const raw = localStorage.getItem('optimizer_import')
    if (!raw) return
    localStorage.removeItem('optimizer_import')
    const imported = JSON.parse(raw)
    if (imported?.legs?.length) {
      setLegs(imported.legs)
      if (imported.coin) setSelectedCrypto(imported.coin)
    }
  } catch {}
}, [])
```

This runs once, reads the stored legs, populates the builder state, then clears the localStorage entry.

**Step 4: Build check**
```bash
npm run build 2>&1 | tail -5
```

**Step 5: Commit**
```bash
git add frontend/components/Header.tsx frontend/app/builder/page.tsx
git commit -m "feat: add Optimizer nav link and builder localStorage import"
```

---

## Task 9: End-to-end smoke test + final build

**Step 1: Start dev servers**
```bash
cd ~/.config/superpowers/worktrees/binance-options/feature/greek-optimizer
node backend/server.js &
cd frontend && npm run dev &
```

**Step 2: Test the optimizer endpoint**
```bash
curl -s -X POST http://localhost:3500/api/optimizer/BTC \
  -H 'Content-Type: application/json' \
  -d '{"targets":{"delta":"neutral","gamma":"long","vega":"ignore","theta":"ignore"},"maxCost":0,"maxLegs":4}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); JSON.parse(d).slice(0,3).forEach(r => console.log(r.name, r.score?.toFixed(2), '$'+r.totalCost?.toFixed(0)))"
```
Expected: 3 strategy names with scores printed.

**Step 3: Open browser and verify**
Navigate to `http://localhost:3000/optimizer`.
- Left panel shows Greek target buttons
- Click "Find Strategies"
- Result cards appear with legs table, Greek bars, rebalancing note
- "Load in Builder" opens `/builder` in new tab with legs pre-populated

**Step 4: Final production build**
```bash
cd frontend && npm run build
```
Expected: build passes, no TS errors.

**Step 5: Final commit**
```bash
git add -A
git commit -m "feat: greek optimizer — complete implementation

New /optimizer page with backend strategy enumeration across 15+
templates (straddle through Christmas tree), best-exchange routing,
Greek scoring, delta hedge insertion, and static rebalancing notes.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Checklist

- [ ] Task 1: `backend/lib/optimizer.js` — core algorithm
- [ ] Task 2: `POST /api/optimizer/:coin` endpoint
- [ ] Task 3: `frontend/types/optimizer.ts` TypeScript types
- [ ] Task 4: `frontend/components/optimizer/GreekBar.tsx`
- [ ] Task 5: `frontend/components/optimizer/ResultCard.tsx`
- [ ] Task 6: `frontend/components/optimizer/TargetInputs.tsx`
- [ ] Task 7: `frontend/app/optimizer/page.tsx`
- [ ] Task 8: Header nav link + builder localStorage import
- [ ] Task 9: End-to-end smoke test + final build
