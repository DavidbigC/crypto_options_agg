# Raw IV Surface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a backend-computed raw mark-IV surface to the analysis API and render it on the analysis page as a normalized expiry-by-moneyness chart.

**Architecture:** Extend the backend analysis cache with a `rawSurface` section computed from live option chains using OTM `markVol` data bucketed by log-moneyness. Consume that payload on the frontend analysis page and render a heatmap-style chart with expiry on the x-axis, moneyness buckets on the y-axis, and color mapped to average mark IV.

**Tech Stack:** Node.js, Express, existing backend analysis cache, Next.js App Router, React, TypeScript, Recharts, existing analysis page polling.

---

### Task 1: Add backend raw-surface computation

**Files:**
- Modify: `/Users/davidc/Scripts/binance options/backend/lib/analysis.js`
- Test: `/Users/davidc/Scripts/binance options/backend/lib/analysis.js` via local node script or targeted test harness

**Step 1: Write the failing test**

Create a small local fixture in a scratch node command that calls `computeAnalysis()` with:

- one future expiry
- one past expiry
- OTM call and put contracts with `markVol`
- a few duplicate contracts that should land in the same bucket

Assert that:

- past expiry is excluded
- `rawSurface` exists
- only OTM points are included
- the bucket average matches expected IV percent

**Step 2: Run test to verify it fails**

Run: `node --input-type=module`

Expected: failure because `rawSurface` is not returned yet.

**Step 3: Write minimal implementation**

In `computeAnalysis()`:

- add helper logic to build a fixed log-moneyness bucket grid
- collect OTM `markVol` points by expiry
- aggregate `avgMarkIV`, `count`, `minStrike`, `maxStrike`
- return `rawSurface` alongside `sviFits`, `termStructure`, and `skewData`

Keep the format compact and serializable.

**Step 4: Run test to verify it passes**

Run the same `node --input-type=module` assertion script.

Expected: PASS with correct `rawSurface` structure.

**Step 5: Commit**

```bash
git -C "/Users/davidc/Scripts/binance options/backend" add lib/analysis.js
git -C "/Users/davidc/Scripts/binance options/backend" commit -m "feat: add raw iv surface to analysis cache"
```

### Task 2: Wire new analysis payload types into the frontend

**Files:**
- Modify: `/Users/davidc/Scripts/binance options/frontend/app/analysis/page.tsx`

**Step 1: Write the failing test**

Create a minimal TypeScript shape in the page for `analysisData.rawSurface` and intentionally reference it in rendering.

Expected failure mode: TypeScript errors until the state type includes the new payload.

**Step 2: Run test to verify it fails**

Run: `npm run lint`

Expected: type or property errors on `rawSurface`.

**Step 3: Write minimal implementation**

Update the `analysisData` state type in `app/analysis/page.tsx` to include:

- `expiries`
- `buckets`
- `cells`

matching the backend response.

**Step 4: Run test to verify it passes**

Run: `npm run lint`

Expected: no type errors related to `rawSurface`.

**Step 5: Commit**

```bash
git -C "/Users/davidc/Scripts/binance options/frontend" add app/analysis/page.tsx
git -C "/Users/davidc/Scripts/binance options/frontend" commit -m "refactor: type raw iv surface analysis payload"
```

### Task 3: Render the raw IV surface chart on the analysis page

**Files:**
- Modify: `/Users/davidc/Scripts/binance options/frontend/app/analysis/page.tsx`
- Optionally modify: `/Users/davidc/Scripts/binance options/frontend/app/globals.css`

**Step 1: Write the failing test**

Add rendering logic that expects `analysisData.rawSurface.cells` to display a chart card.

Expected failure mode: empty or malformed chart until data-to-series transformation exists.

**Step 2: Run test to verify it fails**

Run: `npm run lint`

Expected: render/data-transform issues or unused variables while the chart wiring is incomplete.

**Step 3: Write minimal implementation**

Add a new `Raw IV Surface` card that:

- derives heatmap-ready rows from backend cells
- renders a chart using existing chart primitives or SVG overlays within Recharts
- colors cells by `avgMarkIV`
- shows tooltip details for expiry, bucket, IV, count, and strike range
- shows empty state when `rawSurface` has no cells

Prefer the simplest implementation that is readable and responsive.

**Step 4: Run test to verify it passes**

Run: `npm run lint`

Expected: chart code is type-safe and lint-clean.

**Step 5: Commit**

```bash
git -C "/Users/davidc/Scripts/binance options/frontend" add app/analysis/page.tsx app/globals.css
git -C "/Users/davidc/Scripts/binance options/frontend" commit -m "feat: render raw iv surface chart on analysis page"
```

### Task 4: Verify end-to-end behavior against live analysis data

**Files:**
- Verify only

**Step 1: Start backend**

Run:

```bash
npm run dev
```

in `/Users/davidc/Scripts/binance options/backend`

Expected: API serves `/api/analysis/:exchange/:coin` with `rawSurface`.

**Step 2: Start frontend**

Run:

```bash
npm run dev
```

in `/Users/davidc/Scripts/binance options/frontend`

Expected: analysis page loads and renders the new chart.

**Step 3: Verify live payload**

Open the analysis endpoint in browser or with curl and confirm:

- `rawSurface.expiries.length > 0`
- `rawSurface.buckets.length > 0`
- `rawSurface.cells.length > 0`

**Step 4: Verify UI behavior**

Check:

- chart renders for BTC
- empty states behave for unsupported/no-data exchanges
- tooltip values are sensible
- mobile width still works

**Step 5: Commit**

```bash
git -C "/Users/davidc/Scripts/binance options/backend" status --short
git -C "/Users/davidc/Scripts/binance options/frontend" status --short
```

No new commit in this step unless verification changes are needed.
