# Greek Optimizer — Design Doc
_2026-03-10_

## Overview

A new `/optimizer` page that takes Greek targets as input and returns concrete multi-leg trade recommendations with best exchange routing per leg. Dashboard only — no execution, no position tracking. The user handles all execution and rebalancing manually; the system only surfaces what the trade looks like and when rebalancing would be needed.

---

## Page Layout

**URL**: `/optimizer`

**Left panel — Inputs**
- Coin: BTC / ETH / SOL
- Greek targets — for each of Δ, Γ, ν (vega), Θ: `Long` / `Short` / `Neutral` / `Don't care`
- Max premium (USD cost cap)
- Max legs: 2 / 3 / 4 / 5 / 6 (default 4)
- Run button (on-demand, not auto)

**Right panel — Results**
- Top 10 ranked strategy cards (see card spec below)
- Ranked by score descending

---

## Strategy Templates

The algorithm enumerates these templates, parameterized by strike(s) and expiry(ies):

| Template | Legs | Primary Greek profile |
|---|---|---|
| Straddle | 2 | Long Γ + ν, neutral Δ |
| Strangle | 2 | Long Γ + ν, cheaper than straddle |
| Call calendar | 2 | Long ν, low Γ |
| Put calendar | 2 | Long ν, low Γ |
| Diagonal | 2 | Γ/ν tradeoff, slight Δ |
| Ratio call spread | 3 | High Γ, partial premium offset |
| Ratio put spread | 3 | High Γ, partial premium offset |
| Iron condor | 4 | Short Γ + ν, collect Θ |
| Call butterfly | 3 | Pinned Γ (bounded) |
| Put butterfly | 3 | Pinned Γ (bounded) |
| Jade lizard | 3 | Short ν + Θ collection, upside defined |
| Call ladder | 3–4 | Directional long Γ |
| Put ladder | 3–4 | Directional long Γ |
| Broken wing butterfly | 4 | Skewed Γ, one-sided risk |
| Christmas tree | 6 | Complex Γ shaping, capped cost |

Templates above `maxLegs` are skipped.

---

## Algorithm (backend)

### Input
```ts
POST /api/optimizer/:coin
{
  targets: {
    delta:  'long' | 'short' | 'neutral' | 'ignore',
    gamma:  'long' | 'short' | 'neutral' | 'ignore',
    vega:   'long' | 'short' | 'neutral' | 'ignore',
    theta:  'long' | 'short' | 'neutral' | 'ignore',
  },
  maxCost: number,   // USD
  maxLegs: number,   // 2–6
}
```

### Steps

**1. Build universe**
- All options across bybit / okx / deribit from cached data, with live Greeks (delta, gamma, theta, vega, markPrice)
- All available perps + dated futures for delta hedging

**2. Enumerate templates**
- For each template ≤ maxLegs:
  - Sweep strikes: ATM ± 3σ grid (σ estimated from ATM IV × √T × S)
  - Sweep expiries: all available (pairs for calendar/diagonal)
  - Build leg list with side (buy/sell), type (call/put/future), strike, expiry

**3. Best exchange routing per leg**
- For each leg, call `bestPrice(contract, side, activeExchanges)` across bybit/okx/deribit
- Assign each leg to the exchange with the best available price
- Apply taker fee estimates per exchange

**4. Add delta hedge**
- Compute net delta of option legs
- If `targets.delta === 'neutral'`: add futures/perp leg to bring net delta → 0
- Use `pickHedge()` to select the right instrument per expiry

**5. Score**
```
score = Σ_g [ weight[g] × alignment(netGreek[g], target[g]) ] / totalCost
```
- `alignment` = +1 if Greek matches target direction, −1 if opposite, 0 for 'ignore'
- `weight[g]` = 1.0 for each targeted Greek (equal weighting, may expose as advanced option later)
- Divide by `totalCost` to prefer cheaper strategies for same Greek exposure
- Filter out: net cost > maxCost, any leg with no price on any exchange

**6. Return top 10**
Sorted by score descending.

---

## Result Card Spec

```
┌─────────────────────────────────────────────────────────┐
│  Straddle + Perp Hedge              Score: 8.4   $2,420  │
├─────────────────────────────────────────────────────────┤
│  Side  Type   Strike  Expiry   Exchange  Price    Qty    │
│  Buy   Call   95,000  28-Mar   Deribit   $1,240   1      │
│  Buy   Put    95,000  28-Mar   Bybit     $1,180   1      │
│  Sell  Perp   —       —        Deribit   —        0.18   │
├─────────────────────────────────────────────────────────┤
│  Δ  ░░░░░░░░░░  ~0.00   ✓ neutral                        │
│  Γ  ████████░░  +0.018  ✓ long                           │
│  ν  ████░░░░░░  +$84    → don't care                     │
│  Θ  ██░░░░░░░░  -$42/day                                 │
├─────────────────────────────────────────────────────────┤
│  ⚠ Rebalancing: delta drifts ~+0.01 per $500 spot move. │
│  Consider re-hedging futures when spot moves ±3.2%       │
│  (~$3,040). Near leg expires in 18 days — roll before.   │
├─────────────────────────────────────────────────────────┤
│                              [ Load in Builder → ]       │
└─────────────────────────────────────────────────────────┘
```

### Rebalancing note generation (static)
- **Delta drift trigger**: `rebalance_move = delta_tolerance / gamma` where `delta_tolerance = 0.10` (rebalance when delta drifts > 0.10)
- **Near-dated roll warning**: if any leg expires within 14 days
- **Calendar/diagonal vega flip warning**: if short leg expires first, note that vega exposure reverses after short leg expires

---

## Backend Architecture

### New file: `backend/lib/optimizer.js`
- `buildUniverse(coin)` — pulls from existing options + futures cache
- `enumerateStrategies(universe, targets, maxLegs)` — template enumeration + scoring
- `routeLegs(legs)` — best exchange per leg using `bestPrice` logic
- `computeRebalancingNote(netGreeks, legs)` — generates static warning text
- `runOptimizer(coin, targets, maxCost, maxLegs)` — full pipeline, returns top 10

### New endpoint: `backend/server.js`
```
POST /api/optimizer/:coin
→ calls runOptimizer(), returns JSON array of results
```

No caching needed — runs against already-cached options data. Response time target: <500ms.

### New frontend files
- `frontend/app/optimizer/page.tsx` — page shell + state
- `frontend/components/optimizer/TargetInputs.tsx` — left panel inputs
- `frontend/components/optimizer/ResultCard.tsx` — individual strategy card
- `frontend/components/optimizer/GreekBar.tsx` — visual Greek bar component

### Existing files modified
- `frontend/components/Header.tsx` — add Optimizer nav link
- `backend/server.js` — register new POST route

---

## Data Flow

```
User sets targets + clicks Run
  → POST /api/optimizer/BTC { targets, maxCost, maxLegs }
  → backend: buildUniverse() from cache
  → enumerateStrategies() → score → top 10
  → routeLegs() → bestPrice per leg
  → computeRebalancingNote()
  → return JSON
  → frontend renders result cards
  → user clicks "Load in Builder" → navigates to /builder with legs pre-populated
```

---

## Out of Scope

- Auto-execution or order placement
- Live position monitoring or P&L tracking
- Greeks stress testing (that's the builder's job)
- Real-time result updating (run is manual)
