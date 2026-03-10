# Scanner Long/Short Direction Toggle

**Goal:** Add a Long/Short toggle to GammaScanner and VegaScanner. Short mode uses bid prices, inverts ranking (highest BE = most cushion), and loads the builder with `action: 'sell'`. Column header "Cost" becomes "Premium" in short mode.

---

## Files to Change

| File | Change |
|------|--------|
| `frontend/components/scanners/GammaScanner.tsx` | Add direction toggle, getBestBid, invert sort/selection, sell action |
| `frontend/components/scanners/VegaScanner.tsx` | Same as above |

---

## Shared Logic (both files)

### `getBestBid` helper (mirrors `getBestAsk`):
```ts
function getBestBid(contract: any, activeExchanges?: Set<string>): number {
  if (activeExchanges && contract.prices) {
    let best = 0
    for (const ex of Array.from(activeExchanges)) {
      const bid = contract.prices[ex]?.bid
      if (bid && bid > 0 && (best === 0 || bid > best)) best = bid
    }
    if (best > 0) return best
  }
  return (contract.bestBid ?? contract.bid) || 0
}
```

### Direction state:
```ts
const [direction, setDirection] = useState<'long' | 'short'>('long')
```

### Toggle UI (in header, next to row count):
```tsx
<div className="flex rounded overflow-hidden border border-rim text-[11px]">
  <button
    onClick={() => setDirection('long')}
    className={direction === 'long' ? 'px-2 py-0.5 bg-violet-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
  >Long</button>
  <button
    onClick={() => setDirection('short')}
    className={direction === 'short' ? 'px-2 py-0.5 bg-rose-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
  >Short</button>
</div>
```
*(Vega scanner uses `emerald-500` for long button instead of `violet-500`)*

---

## Task 1: GammaScanner.tsx

### Pricing:
- Pass `direction` into `useMemo` deps
- Use `getBestBid` when `direction === 'short'`, `getBestAsk` when `'long'`

### Straddle:
```ts
const callPrice = direction === 'short' ? getBestBid(atmCall, activeExchanges) : getBestAsk(atmCall, activeExchanges)
const putPrice  = direction === 'short' ? getBestBid(atmPut,  activeExchanges) : getBestAsk(atmPut,  activeExchanges)
```

### Strangle selection:
- Long: `if (bestStrangle && be >= bestStrangle.be) continue` (keep lowest BE)
- Short: `if (bestStrangle && be <= bestStrangle.be) continue` (keep highest BE)

### Sort:
```ts
return results.sort((a, b) =>
  daysToEvent
    ? direction === 'short'
      ? (b.beToEvent ?? 0) - (a.beToEvent ?? 0)   // short: highest first
      : (a.beToEvent ?? Infinity) - (b.beToEvent ?? Infinity)  // long: lowest first
    : direction === 'short'
      ? b.be - a.be   // short: highest first
      : a.be - b.be   // long: lowest first
)
```

### Column header:
```tsx
<th>…{direction === 'short' ? 'Premium' : 'Cost'}</th>
```

### handleLoad (short mode uses bid + sell action):
```ts
const getPrice = (contract: any) =>
  direction === 'short' ? getBestBid(contract, activeExchanges) : getBestAsk(contract, activeExchanges)
const callPrice = getPrice(call)
const putPrice  = getPrice(put)
// resolve exchange from bid prices when short
const callEx = direction === 'short'
  ? (activeExchanges && callPrices ? Array.from(activeExchanges).find(ex => callPrices[ex]?.bid === callPrice) ?? exchange : (call as any).bestBidEx ?? exchange)
  : /* existing long logic */
// legs action:
{ type: 'call', action: direction === 'short' ? 'sell' : 'buy', ... }
{ type: 'put',  action: direction === 'short' ? 'sell' : 'buy', ... }
```

### Highlight color: rose for short (best row):
```ts
'bg-rose-50 dark:bg-rose-950/20': isBest && direction === 'short' && !daysToEvent,
'text-rose-600 dark:text-rose-400': isBest && direction === 'short' && !daysToEvent,
```

---

## Task 2: VegaScanner.tsx

Same pattern as GammaScanner, with these differences:

### Strangle selection:
- Long: keep highest `vegaPerDollar` (i.e. `if bestStrangle && row.vegaPerDollar <= bestStrangle.vegaPerDollar`)
- Short: keep highest `beIVMove` (i.e. `if bestStrangle && row.beIVMove <= bestStrangle.beIVMove`)

### Sort:
```ts
return results.sort((a, b) =>
  daysToEvent
    ? direction === 'short'
      ? ((b.thetaToEvent ?? 0) / b.vega) - ((a.thetaToEvent ?? 0) / a.vega)  // short: most theta collected
      : ((a.thetaToEvent ?? 0) / a.vega) - ((b.thetaToEvent ?? 0) / b.vega)
    : direction === 'short'
      ? b.beIVMove - a.beIVMove  // short: highest BE IV first
      : a.beIVMove - b.beIVMove
)
```

### Long button color: `emerald-500` (matches existing vega theme).

---

## Todo

- [ ] Task 1: GammaScanner — getBestBid, direction state, toggle UI, invert selection/sort, column header, handleLoad sell action, rose highlight
- [ ] Task 2: VegaScanner — same changes, emerald long button, invert strangle selection by beIVMove
- [ ] Verify TypeScript
