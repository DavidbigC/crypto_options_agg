# Position Builder — Design

## Overview

A separate `/builder` page where users browse a live mini options chain, add legs to a multi-leg position, and simulate P&L across price and time using Black-Scholes.

---

## Layout

Two-column layout at `/builder`:

- **Left (35%)** — Mini chain picker
- **Right (65%)** — Legs panel (top) + P&L chart (bottom)

Header nav gets a "Builder" link. Page opens pre-filtered via URL param: `/builder?coin=BTC`.

---

## Section 1: Mini Chain Picker (Left Column)

- Exchange/crypto tabs at top (reuses existing state)
- Expiry selector (dropdown or compact tabs)
- Compact chain table columns: Strike, Call Bid, Call Ask, Put Bid, Put Ask, Delta
- Clicking **Ask** → adds a **Buy** leg pre-filled at ask price
- Clicking **Bid** → adds a **Sell** leg pre-filled at bid price

---

## Section 2: Legs Panel (Right Column, Top Half)

Each leg is a row:

| ✓ | Side | Expiry | Strike | C/P | Qty | Entry Price | Current Value | P&L | × |
|---|------|--------|--------|-----|-----|-------------|---------------|-----|---|

- **Checkbox** — toggle leg on/off in simulation (keeps the leg, excludes from calc)
- **Side** — Buy/Sell pill, clickable to flip
- **Qty** — editable number input
- **Entry Price** — defaults to ask (buy) or bid (sell), editable
- **Current Value** — live mark price from chain feed
- **P&L** — `(currentValue − entryPrice) × qty × contractSize × sign`, green/red
- **× button** — removes the leg

**Summary row** at the bottom: total cost basis, total current value, net P&L.

---

## Section 3: P&L Chart (Right Column, Bottom Half)

### Curves
- **Solid line** — P&L at today's date
- **Dashed line** — P&L at the date selected by the date slider

### Controls (above chart)
- **Date slider** — today → earliest leg expiry. Reprices all legs via BS at that date.
- **IV stress slider** — −80% to +300%. Scales all legs' baseline IV proportionally.

### Annotations
- Horizontal dashed line at y=0
- **Breakeven dots** where each curve crosses zero, labeled with price
- Vertical dashed line at current spot
- **Tooltip on hover** — shows BTC price, P&L for both curves

### Below chart — Greeks Summary Bar
Total position Greeks at current spot + selected date:
- Δ (Delta), Γ (Gamma), Θ (Theta), Vega

---

## Section 4: Pricing Engine

All computation runs **client-side** (no backend calls needed).

### Black-Scholes inputs per leg
- `S` — spot price (swept across x-axis, ±30% from current spot by default)
- `K` — strike from leg
- `T` — time to expiry in years, adjusted by date slider
- `σ` — `markVol` from chain data × IV stress multiplier
- `r` — 0 (crypto convention)

### P&L per point
```
legValue = BS(S, K, T, σ, r, type) × qty × contractSize × sign(buy=+1, sell=−1)
legPnL   = legValue − entryPrice × qty × contractSize × sign
totalPnL = sum of active legs
```

### Contract sizes
| Exchange | Asset | Contract Size |
|----------|-------|---------------|
| Bybit    | BTC   | 1 BTC         |
| Bybit    | ETH   | 1 ETH         |
| OKX      | BTC   | 0.1 BTC       |
| OKX      | ETH   | 1 ETH         |

### Edge cases
- `T ≤ 0` (at/past expiry): use intrinsic value directly to avoid BS division-by-zero
- IV stress resulting in σ ≤ 0: clamp to 0.001

---

## New Files

| File | Purpose |
|------|---------|
| `frontend/app/builder/page.tsx` | Builder page route |
| `frontend/components/builder/MiniChain.tsx` | Left column: compact chain picker |
| `frontend/components/builder/LegsPanel.tsx` | Legs list with summary row |
| `frontend/components/builder/PnLChart.tsx` | Chart with sliders + Greeks bar |
| `frontend/lib/blackScholes.ts` | BS pricing + Greeks functions |

---

## State

All builder state lives in `builder/page.tsx` and is passed down as props:

```ts
interface Leg {
  id: string
  exchange: Exchange
  symbol: string
  expiry: string
  strike: number
  type: 'call' | 'put'
  side: 'buy' | 'sell'
  qty: number
  entryPrice: number
  markVol: number        // σ baseline from chain
  contractSize: number
  enabled: boolean
}
```

No persistence for now (legs reset on page refresh).
