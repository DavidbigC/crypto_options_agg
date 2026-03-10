# Optimizer v2 — Target Expiry Filter + Missing Strategies

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a target expiry date filter to the optimizer and fill in 12 missing strategy templates from the options handbook.

**Architecture:** Two independent changes — (1) `targetExpiry` is an optional string (`YYYY-MM-DD`) threaded from the frontend input through the API body into `runOptimizer`, which uses it to restrict which expiries are enumerated; (2) new strategy templates are appended to `enumSingleExpiry` following the existing pattern. No new files needed.

**Tech Stack:** Node.js ESM backend, Next.js 14 + TypeScript frontend, Tailwind CSS.

---

## Key Conventions

- Backend: `backend/lib/optimizer.js` — ESM, pure functions, no imports of caches
- Frontend types: `frontend/types/optimizer.ts`
- Frontend inputs: `frontend/components/optimizer/TargetInputs.tsx`
- Page state: `frontend/app/optimizer/page.tsx`
- Build check: `cd frontend && npm run build` — must pass after every task
- Working directory: `/Users/davidc/Scripts/binance options`

---

## Task 1: Add `targetExpiry` to TypeScript types and backend

**Files:**
- Modify: `frontend/types/optimizer.ts`
- Modify: `backend/lib/optimizer.js`
- Modify: `backend/server.js`

### Step 1: Update `OptimizerRequest` in `frontend/types/optimizer.ts`

Find:
```ts
export interface OptimizerRequest {
  targets:  OptimizerTargets
  maxCost:  number
  maxLegs:  number
}
```

Replace with:
```ts
export interface OptimizerRequest {
  targets:      OptimizerTargets
  maxCost:      number
  maxLegs:      number
  targetExpiry: string | null   // 'YYYY-MM-DD' or null for all expiries
}
```

### Step 2: Add expiry filtering to `runOptimizer` in `backend/lib/optimizer.js`

Find the `runOptimizer` signature:
```js
export function runOptimizer(combinedOptionsData, spotPrice, futures, targets, maxCost, maxLegs) {
```

Replace with:
```js
export function runOptimizer(combinedOptionsData, spotPrice, futures, targets, maxCost, maxLegs, targetExpiry = null) {
```

Find the line that builds the expirations array inside `runOptimizer`:
```js
  const expirations   = futureExpirations(combinedOptionsData.expirations || [])
```

Replace with:
```js
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
```

### Step 3: Pass `targetExpiry` through in `backend/server.js`

Find the optimizer route body destructuring:
```js
  const { targets = {}, maxCost = 0, maxLegs = 4 } = req.body
```

Replace with:
```js
  const { targets = {}, maxCost = 0, maxLegs = 4, targetExpiry = null } = req.body
```

Find the `runOptimizer` call:
```js
    const results = runOptimizer(combined, spotPrice, futures, targets, maxCost, Math.min(maxLegs, 6))
```

Replace with:
```js
    const results = runOptimizer(combined, spotPrice, futures, targets, maxCost, Math.min(maxLegs, 6), targetExpiry || null)
```

### Step 4: Syntax check

```bash
node --check backend/server.js && echo "OK"
node --input-type=module --eval "import('./backend/lib/optimizer.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: two `OK` lines.

### Step 5: Commit

```bash
cd "/Users/davidc/Scripts/binance options"
git add frontend/types/optimizer.ts backend/lib/optimizer.js backend/server.js
git commit -m "feat: add targetExpiry filter to optimizer backend"
```

---

## Task 2: Add target expiry date picker to `TargetInputs` and page

**Files:**
- Modify: `frontend/components/optimizer/TargetInputs.tsx`
- Modify: `frontend/app/optimizer/page.tsx`

### Step 1: Add `targetExpiry` prop to `TargetInputs`

In `TargetInputs.tsx`, find the interface:
```tsx
interface TargetInputsProps {
  coin:            'BTC' | 'ETH' | 'SOL'
  targets:         OptimizerTargets
  maxCost:         number
  maxLegs:         number
  loading:         boolean
  onCoinChange:    (c: 'BTC' | 'ETH' | 'SOL') => void
  onTargetChange:  (greek: keyof OptimizerTargets, val: GreekTarget) => void
  onMaxCostChange: (v: number) => void
  onMaxLegsChange: (v: number) => void
  onRun:           () => void
}
```

Replace with:
```tsx
interface TargetInputsProps {
  coin:                'BTC' | 'ETH' | 'SOL'
  targets:             OptimizerTargets
  maxCost:             number
  maxLegs:             number
  targetExpiry:        string
  loading:             boolean
  onCoinChange:        (c: 'BTC' | 'ETH' | 'SOL') => void
  onTargetChange:      (greek: keyof OptimizerTargets, val: GreekTarget) => void
  onMaxCostChange:     (v: number) => void
  onMaxLegsChange:     (v: number) => void
  onTargetExpiryChange:(v: string) => void
  onRun:               () => void
}
```

Find the function signature:
```tsx
export default function TargetInputs({
  coin, targets, maxCost, maxLegs, loading,
  onCoinChange, onTargetChange, onMaxCostChange, onMaxLegsChange, onRun,
}: TargetInputsProps) {
```

Replace with:
```tsx
export default function TargetInputs({
  coin, targets, maxCost, maxLegs, targetExpiry, loading,
  onCoinChange, onTargetChange, onMaxCostChange, onMaxLegsChange, onTargetExpiryChange, onRun,
}: TargetInputsProps) {
```

Find the closing `</div>` just before the Run button section (after the Max Legs section):
```tsx
      {/* Run */}
      <button
```

Insert this block before it:
```tsx
      {/* Target expiry */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">
          Target Expiry
          {!targetExpiry && <span className="text-ink-3 ml-1">— all expiries</span>}
        </label>
        <input
          type="date"
          value={targetExpiry}
          onChange={e => onTargetExpiryChange(e.target.value)}
          className="w-full px-2.5 py-1.5 text-sm rounded border border-rim bg-card text-ink focus:outline-none focus:border-ink-3"
        />
        {targetExpiry && (
          <button
            onClick={() => onTargetExpiryChange('')}
            className="mt-1 text-[10px] text-ink-3 hover:text-ink transition-colors"
          >
            Clear
          </button>
        )}
      </div>

```

### Step 2: Wire up state in `frontend/app/optimizer/page.tsx`

Find the state declarations block (after `const [spotPrice]`):
```tsx
  const [spotPrice]               = useState(0)
```

Add after it:
```tsx
  const [targetExpiry, setTargetExpiry] = useState('')
```

Find the `handleRun` body where the request body is built:
```tsx
        body: JSON.stringify({ targets, maxCost, maxLegs }),
```

Replace with:
```tsx
        body: JSON.stringify({ targets, maxCost, maxLegs, targetExpiry: targetExpiry || null }),
```

Find the `<TargetInputs` usage and add the two new props:
```tsx
              onRun={handleRun}
```

Replace with:
```tsx
              targetExpiry={targetExpiry}
              onTargetExpiryChange={setTargetExpiry}
              onRun={handleRun}
```

### Step 3: Build check

```bash
cd "/Users/davidc/Scripts/binance options/frontend" && npm run build 2>&1 | tail -6
```

Expected: clean build, `/optimizer` listed in output.

### Step 4: Commit

```bash
cd "/Users/davidc/Scripts/binance options"
git add frontend/components/optimizer/TargetInputs.tsx frontend/app/optimizer/page.tsx
git commit -m "feat: add target expiry date picker to optimizer UI"
```

---

## Task 3: Add missing 2-leg strategies to `enumSingleExpiry`

**Files:**
- Modify: `backend/lib/optimizer.js`

Add the following blocks inside `enumSingleExpiry`, within the `if (maxLegs >= 2)` block, after the existing `Short Strangle` block.

Find the end of the 2-leg block (just before `if (maxLegs >= 3)`):
```js
    if (b.otmCall1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Short Strangle', [
        { side: 'sell', type: 'call', strike: b.otmCall1, expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 3) {
```

Replace with:
```js
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
```

### Step 2: ESM check

```bash
node --input-type=module --eval "import('./backend/lib/optimizer.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: `OK`

### Step 3: Commit

```bash
cd "/Users/davidc/Scripts/binance options"
git add backend/lib/optimizer.js
git commit -m "feat: add vertical spreads, risk reversals, long guts to optimizer"
```

---

## Task 4: Add missing 3-leg strategies

**Files:**
- Modify: `backend/lib/optimizer.js`

Inside the `if (maxLegs >= 3)` block, after the existing `Put Ladder` block, add:

Find (end of existing 3-leg strategies):
```js
    if (b.itmPut1 !== b.atm && b.otmPut1 !== b.atm) {
      add('Put Ladder', [
        { side: 'buy',  type: 'put', strike: b.itmPut1, expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.atm,      expiry, qty: 1 },
        { side: 'sell', type: 'put', strike: b.otmPut1,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 4) {
```

Replace with:
```js
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
```

### Step 2: ESM check + commit

```bash
node --input-type=module --eval "import('./backend/lib/optimizer.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: `OK`

```bash
cd "/Users/davidc/Scripts/binance options"
git add backend/lib/optimizer.js
git commit -m "feat: add backspreads, short butterflies, seagull to optimizer"
```

---

## Task 5: Add missing 4-leg strategies

**Files:**
- Modify: `backend/lib/optimizer.js`

Inside the `if (maxLegs >= 4)` block, after the existing `Iron Butterfly` block, add:

Find:
```js
    if (b.otmCall2 !== b.atm && b.otmPut2 !== b.atm) {
      add('Iron Butterfly', [
        { side: 'buy',  type: 'call', strike: b.otmCall2, expiry, qty: 1 },
        { side: 'sell', type: 'call', strike: b.atm,       expiry, qty: 1 },
        { side: 'sell', type: 'put',  strike: b.atm,       expiry, qty: 1 },
        { side: 'buy',  type: 'put',  strike: b.otmPut2,  expiry, qty: 1 },
      ])
    }
  }

  if (maxLegs >= 5) {
```

Replace with:
```js
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
```

### Step 2: ESM check + build check + commit

```bash
node --input-type=module --eval "import('./backend/lib/optimizer.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"
cd frontend && npm run build 2>&1 | tail -5
```

Expected: `OK` then clean build.

```bash
cd "/Users/davidc/Scripts/binance options"
git add backend/lib/optimizer.js
git commit -m "feat: add reverse iron butterfly, reverse iron condor to optimizer"
```

---

## Task 6: Smoke test all new strategies with mock data

**Files:** None — test only.

Run a quick unit test verifying new strategies appear in results:

```bash
cd "/Users/davidc/Scripts/binance options" && node --input-type=module << 'EOF'
import { runOptimizer } from './backend/lib/optimizer.js'

const spot = 95000
const expiry = '2026-12-26'
const strikes = [80000, 85000, 88000, 90000, 93000, 95000, 97000, 100000, 103000, 105000, 110000]

const calls = strikes.map(k => ({
  strike: k, delta: k <= spot ? 0.7 : 0.3, gamma: 0.00002, theta: -50, vega: 120,
  prices: { bybit: { bid: 300, ask: 350 }, okx: { bid: 295, ask: 345 }, deribit: { bid: 298, ask: 348 } },
  markVol: 0.65,
}))
const puts = strikes.map(k => ({
  strike: k, delta: k <= spot ? -0.3 : -0.7, gamma: 0.00002, theta: -50, vega: 120,
  prices: { bybit: { bid: 300, ask: 350 }, okx: { bid: 295, ask: 345 }, deribit: { bid: 298, ask: 348 } },
  markVol: 0.65,
}))

const mockData = {
  spotPrice: spot, expirations: [expiry],
  data: { [expiry]: { calls, puts, forwardPrice: spot } }
}
const futures = [{ isPerp: true, markPrice: spot, exchange: 'bybit' }]

// Test 1: long delta (should surface bull call spread, risk reversal)
let r = runOptimizer(mockData, spot, futures, { delta: 'long', gamma: 'ignore', vega: 'ignore', theta: 'ignore' }, 0, 6)
console.log('Long delta:', r.slice(0,3).map(x=>x.name).join(', '))

// Test 2: long gamma (should surface backspreads, reverse iron fly)
r = runOptimizer(mockData, spot, futures, { delta: 'neutral', gamma: 'long', vega: 'ignore', theta: 'ignore' }, 0, 6)
console.log('Long gamma:', r.slice(0,3).map(x=>x.name).join(', '))

// Test 3: targetExpiry filter
r = runOptimizer(mockData, spot, futures, { delta: 'neutral', gamma: 'long', vega: 'ignore', theta: 'ignore' }, 0, 4, '2026-12-26')
console.log('With targetExpiry=2026-12-26:', r.length, 'results, all expiry:', r.every(x=>x.legs.every(l=>l.expiry==='2026-12-26'||l.expiry==='perpetual')))

// Test 4: targetExpiry mismatch → 0 results
r = runOptimizer(mockData, spot, futures, { delta: 'neutral', gamma: 'long', vega: 'ignore', theta: 'ignore' }, 0, 4, '2025-01-01')
console.log('With non-matching targetExpiry:', r.length, 'results (expect 0)')
EOF
```

Expected output:
```
Long delta: Bull Call Spread, Risk Reversal (Bullish), ...
Long gamma: Call Backspread, Reverse Iron Butterfly, ...
With targetExpiry=2026-12-26: 10 results, all expiry: true
With non-matching targetExpiry: 0 results (expect 0)
```

If all 4 lines pass, commit:

```bash
cd "/Users/davidc/Scripts/binance options"
git add -A
git commit -m "feat: optimizer v2 — target expiry filter + 12 missing strategies

Adds:
- targetExpiry optional filter (±3 days tolerance) in backend and UI
- Bull/Bear Call/Put Spreads, Risk Reversals (bullish/bearish)
- Long Guts, Call/Put Backspreads, Short Call/Put Butterflies
- Seagull (bullish/bearish), Reverse Iron Butterfly, Reverse Iron Condor

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Checklist

- [ ] Task 1: targetExpiry in types, optimizer.js, server.js
- [ ] Task 2: date picker in TargetInputs + page state
- [ ] Task 3: 2-leg strategies (verticals, risk reversals, long guts)
- [ ] Task 4: 3-leg strategies (backspreads, short butterflies, seagull)
- [ ] Task 5: 4-leg strategies (reverse iron butterfly, reverse iron condor)
- [ ] Task 6: smoke test + final commit
