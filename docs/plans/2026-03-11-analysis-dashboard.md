# Analysis Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign `/analysis` into a chart-driven research dashboard that uses `combined` as the default market view and overlays Bybit, OKX, and Deribit for comparison.

**Architecture:** Keep the current analytics endpoint shape per exchange, fetch the four required datasets in parallel on the frontend, and build comparison transforms in the UI layer. Extend the backend only where the current payload lacks metadata needed for freshness and confidence display. Add a separate chart-interpretation reference doc and concise in-product guidance.

**Tech Stack:** Next.js App Router, React, TypeScript, Recharts, Express, existing analytics cache, Node-based tests where available

---

### Task 1: Audit current analysis dependencies and lock the target file list

**Files:**
- Review: `frontend/app/analysis/page.tsx`
- Review: `backend/lib/analysis.js`
- Review: `backend/server.js`
- Review: `frontend/types/options.ts`
- Review: existing analysis-related tests in `backend/`

**Step 1: Inspect the current implementation**

Read the existing page and backend analytics flow to confirm:
- which exchanges already produce analysis payloads
- where `updatedAt` already exists
- what payload gaps remain for comparison UI work

**Step 2: Write down the concrete file touch list**

Capture the final implementation targets before code changes begin.

Expected files to modify:
- `frontend/app/analysis/page.tsx`
- `backend/lib/analysis.js`
- `frontend/components/Header.tsx` only if navigation or copy changes are needed
- `backend/raw-surface.test.mjs`
- new frontend helpers/tests if the repo already has a matching test pattern
- `docs/plans/2026-03-11-analysis-dashboard-reference.md`

**Step 3: Commit the audit checkpoint**

```bash
git add docs/plans/2026-03-11-analysis-dashboard-design.md docs/plans/2026-03-11-analysis-dashboard.md
git commit -m "docs: add analysis dashboard redesign plan"
```

### Task 2: Add backend metadata needed for research comparison

**Files:**
- Modify: `backend/lib/analysis.js`
- Test: `backend/raw-surface.test.mjs`

**Step 1: Write the failing test**

Extend `backend/raw-surface.test.mjs` to assert the returned analysis object includes enough metadata to support the new UI, such as:
- `updatedAt`
- consistent expiry identifiers
- stable raw-surface bucket keys

If a separate test file is clearer, create:
- `backend/analysis-comparison.test.mjs`

**Step 2: Run test to verify it fails**

Run: `node backend/raw-surface.test.mjs`

Expected:
- FAIL if new metadata assertions are not yet satisfied

**Step 3: Write minimal implementation**

In `backend/lib/analysis.js`:
- preserve and document `updatedAt`
- add any small helper fields needed by the comparison UI only if they are not derivable on the client
- do not add speculative analytics yet

**Step 4: Run test to verify it passes**

Run: `node backend/raw-surface.test.mjs`

Expected:
- PASS

**Step 5: Commit**

```bash
git add backend/lib/analysis.js backend/raw-surface.test.mjs
git commit -m "feat: expose analysis metadata for comparison UI"
```

### Task 3: Add frontend types and comparison helpers

**Files:**
- Create: `frontend/lib/analysisComparison.ts`
- Modify: `frontend/app/analysis/page.tsx`
- Optionally modify: `frontend/types/options.ts`

**Step 1: Write the failing test**

If the frontend has no established unit-test harness, add a small pure-function test near the helper using the project’s existing Node tooling, for example:
- `frontend/lib/analysisComparison.test.mjs`

Cover:
- expiry alignment across exchanges
- ATM IV spread-to-combined calculation
- RR/Fly spread-to-combined calculation
- surface cell spread calculation
- missing-expiry handling

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL because the helper functions do not exist yet

**Step 3: Write minimal implementation**

Create comparison helpers that:
- normalize exchange payloads into one map keyed by exchange
- align term-structure series by expiry
- align skew/fly series by expiry
- build surface comparison cells from `venue - combined`
- derive stale-state labels from `updatedAt`

Keep these transforms out of the page component to avoid an unreadable render function.

**Step 4: Run test to verify it passes**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- PASS

**Step 5: Commit**

```bash
git add frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs frontend/app/analysis/page.tsx frontend/types/options.ts
git commit -m "feat: add analysis comparison transforms"
```

### Task 4: Refactor `/analysis` data fetching around combined plus overlays

**Files:**
- Modify: `frontend/app/analysis/page.tsx`

**Step 1: Write the failing test**

If there is no page-level test harness, use a manual verification checklist captured in comments or task notes and treat this as a behavior-driven task. Verify the page currently fails the target behavior:
- it defaults to `deribit`, not `combined`
- it cannot hold multiple exchange analysis payloads at once

**Step 2: Implement minimal data-fetch changes**

Update the page to:
- default to `combined`
- fetch `combined`, `deribit`, `okx`, and `bybit` analysis payloads in parallel for the selected coin
- keep per-exchange loading/error/freshness state
- keep SSE options-chain data focused on the base dataset needed for the smile view

Do not add final chart polish yet. This task is only about getting the right data into state.

**Step 3: Run manual verification**

Run:
- `npm run dev` in `frontend/`
- verify `/analysis` loads with `combined` as the default research anchor
- verify overlays can be requested without breaking the base chart

Expected:
- page loads
- network requests succeed for `combined`, `deribit`, `okx`, `bybit`

**Step 4: Commit**

```bash
git add frontend/app/analysis/page.tsx
git commit -m "feat: fetch combined and overlay analysis datasets"
```

### Task 5: Rebuild the smile chart as a comparison chart

**Files:**
- Modify: `frontend/app/analysis/page.tsx`

**Step 1: Write the failing test**

Add a pure helper test if needed for smile-series construction:
- align selected expiry across exchanges
- include combined fit as the anchor
- omit overlays when expiry or fit is missing

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL for missing smile comparison helpers

**Step 3: Write minimal implementation**

Update the smile section to:
- show combined fit as the default anchor line
- render overlay fit lines for selected venues
- keep raw points readable by limiting non-combined raw-point overlays
- show RMSE and fit availability per visible series

**Step 4: Run verification**

Run:
- `npm run dev` in `frontend/`
- manually inspect `/analysis`

Expected:
- selected expiry smile shows combined plus selected overlay lines
- missing venue expiries do not produce broken or misleading lines

**Step 5: Commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs
git commit -m "feat: add cross-exchange smile comparison"
```

### Task 6: Rebuild term structure with level and spread modes

**Files:**
- Modify: `frontend/app/analysis/page.tsx`
- Modify: `frontend/lib/analysisComparison.ts`
- Test: `frontend/lib/analysisComparison.test.mjs`

**Step 1: Write the failing test**

Add tests for:
- level-series alignment by expiry
- spread-to-combined calculation in vol points
- missing-expiry gaps

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL until the term helpers exist

**Step 3: Write minimal implementation**

Implement:
- `Level` mode: combined plus selected venue curves
- `Spread vs Combined` mode: venue minus combined
- legend labels that include freshness or unavailable state where needed

**Step 4: Run verification**

Run:
- `npm run dev` in `frontend/`
- inspect BTC and ETH term views

Expected:
- mode switch works
- spreads are legible and only shown for matched expiries

**Step 5: Commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs
git commit -m "feat: add term structure comparison modes"
```

### Task 7: Rebuild skew and butterfly with comparison modes

**Files:**
- Modify: `frontend/app/analysis/page.tsx`
- Modify: `frontend/lib/analysisComparison.ts`
- Test: `frontend/lib/analysisComparison.test.mjs`

**Step 1: Write the failing test**

Add tests for:
- RR level alignment
- Fly level alignment
- RR/Fly spread-to-combined calculations
- missing delta-data handling

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL until the skew comparison transform is implemented

**Step 3: Write minimal implementation**

Update the skew card to:
- support `Level` and `Spread vs Combined`
- show combined as anchor data
- overlay selected venue data only where available
- keep tooltips explicit about whether a value is absolute or a spread

**Step 4: Run verification**

Run:
- `npm run dev` in `frontend/`

Expected:
- RR/Fly charts correctly switch modes
- missing venue data is not plotted as zero

**Step 5: Commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs
git commit -m "feat: add skew comparison modes"
```

### Task 8: Rebuild the surface as combined heatmap plus venue spread view

**Files:**
- Modify: `frontend/app/analysis/page.tsx`
- Modify: `frontend/lib/analysisComparison.ts`
- Test: `frontend/lib/analysisComparison.test.mjs`

**Step 1: Write the failing test**

Add tests for:
- surface cell matching by `exp` and `bucketKey`
- venue-minus-combined cell spreads
- missing cell handling
- low-count state derivation if implemented client-side

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL until the surface comparison helpers exist

**Step 3: Write minimal implementation**

Update the surface card to:
- show combined heatmap in default mode
- add a comparison mode with a single selected venue
- color comparison cells by signed spread rather than absolute IV
- expand hover details to include combined IV, venue IV, spread, count, and strikes

**Step 4: Run verification**

Run:
- `npm run dev` in `frontend/`

Expected:
- combined heatmap remains readable
- venue spread mode clearly reveals rich/cheap regions

**Step 5: Commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs
git commit -m "feat: add surface spread comparison view"
```

### Task 9: Add freshness, availability, and weak-data guardrails

**Files:**
- Modify: `frontend/app/analysis/page.tsx`
- Modify: `frontend/lib/analysisComparison.ts`

**Step 1: Write the failing test**

Add tests for stale-state derivation if it is in helper code:
- fresh
- aging
- stale
- unavailable

**Step 2: Run test to verify it fails**

Run: `node frontend/lib/analysisComparison.test.mjs`

Expected:
- FAIL until stale-state helpers exist

**Step 3: Write minimal implementation**

Add:
- per-exchange freshness labels using `updatedAt`
- unavailable overlay messaging
- fit-unavailable and low-count indicators
- explicit missing-expiry messaging where overlays drop out

**Step 4: Run verification**

Run:
- `npm run dev` in `frontend/`

Expected:
- stale and unavailable states are visible without obscuring the base chart

**Step 5: Commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs
git commit -m "feat: add analysis data quality guardrails"
```

### Task 10: Add in-product chart guidance

**Files:**
- Modify: `frontend/app/analysis/page.tsx`

**Step 1: Write the failing test**

If there is no page test harness, define a manual verification target:
- the page should expose a visible “How to read this” section
- each chart should have concise interpretation guidance

**Step 2: Write minimal implementation**

Add a compact accordion or expandable panel with short sections for:
- smile
- term structure
- skew/fly
- surface

Each section must include:
- what the chart measures
- what to compare first
- one interpretation trap

**Step 3: Run verification**

Run:
- `npm run dev` in `frontend/`

Expected:
- guidance is readable and does not overwhelm the main chart area

**Step 4: Commit**

```bash
git add frontend/app/analysis/page.tsx
git commit -m "feat: add analysis chart guidance"
```

### Task 11: Write the full reference document for chart meaning and usage

**Files:**
- Create: `docs/plans/2026-03-11-analysis-dashboard-reference.md`

**Step 1: Draft the document**

Include sections for:
- purpose of the dashboard
- what the combined dataset means
- how to use overlays responsibly
- smile interpretation
- term structure interpretation
- skew/fly interpretation
- surface interpretation
- exact computation notes based on current backend logic
- common traps and limitations

**Step 2: Link the doc from the page**

If appropriate, add a link from `/analysis` to the new document.

**Step 3: Review for accuracy**

Cross-check every computation statement against:
- `backend/lib/analysis.js`
- any relevant data-fetch or merge logic in `frontend/app/analysis/page.tsx`

**Step 4: Commit**

```bash
git add docs/plans/2026-03-11-analysis-dashboard-reference.md frontend/app/analysis/page.tsx
git commit -m "docs: add analysis dashboard reference guide"
```

### Task 12: Final verification

**Files:**
- Review only

**Step 1: Run backend verification**

Run:
- `node backend/raw-surface.test.mjs`
- `node frontend/lib/analysisComparison.test.mjs`

Expected:
- PASS

**Step 2: Run frontend verification**

Run:
- `npm run dev` in `frontend/`

Manual checks:
- `/analysis` defaults to `combined`
- overlay toggles work for BTC, ETH, and SOL
- smile, term, skew, and surface all support comparison correctly
- missing overlay data is explicit
- freshness labels appear
- guidance panel and reference-doc link are visible

**Step 3: Review git diff**

Run:
- `git status --short`
- `git diff --stat`

Expected:
- only intended files changed

**Step 4: Final commit**

```bash
git add frontend/app/analysis/page.tsx frontend/lib/analysisComparison.ts frontend/lib/analysisComparison.test.mjs backend/lib/analysis.js backend/raw-surface.test.mjs docs/plans/2026-03-11-analysis-dashboard-reference.md
git commit -m "feat: redesign analysis dashboard for research comparison"
```
