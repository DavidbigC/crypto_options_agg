# OKX Portfolio Greeks And Simulator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add live derivatives Greeks and a per-coin editable simulator to the OKX portfolio page, seeded from live OKX options and futures positions.

**Architecture:** Extend the backend portfolio payload with parsed derivatives metadata and aggregate Greeks, then build a portfolio-specific simulator UI that reuses the existing builder leg and chart primitives. Keep live portfolio data separate from local simulator state so refreshes do not wipe user what-if edits.

**Tech Stack:** Node.js, Express, Node `node:test`, Next.js 14, React, TypeScript, Tailwind CSS

---

### Task 1: Extend backend portfolio normalization for derivatives metadata and Greek aggregates

**Files:**
- Modify: `backend/lib/okx-portfolio.js`
- Modify: `backend/okx-portfolio.test.mjs`

**Step 1: Write the failing test**

Add tests asserting that normalized positions include parsed `coin`, `kind`, `expiry`, `strike`, `optionType`, and that the payload includes `greeks.total` and `greeks.byCoin`.

**Step 2: Run test to verify it fails**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: FAIL because the normalized payload lacks parsed derivatives metadata and aggregate Greeks.

**Step 3: Write minimal implementation**

Implement instrument parsing and Greek aggregation in `backend/lib/okx-portfolio.js`.

**Step 4: Run test to verify it passes**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: PASS

### Task 2: Add frontend portfolio transformation helpers

**Files:**
- Modify: `frontend/lib/portfolio.ts`

**Step 1: Add pure helpers**

Add helpers for:
- grouping live positions by coin
- building simulator `Leg[]` from normalized portfolio positions
- grouping live Greeks by coin

**Step 2: Verify with build**

Run: `npm run build`
Expected: existing frontend still builds with the new helper types.

### Task 3: Reuse futures adder in both builder and portfolio flows

**Files:**
- Create: `frontend/components/builder/FuturesBar.tsx`
- Modify: `frontend/app/builder/page.tsx`

**Step 1: Extract the existing futures adder**

Move the current inline `FuturesBar` from the builder page into a shared component and keep builder behavior unchanged.

**Step 2: Verify**

Run: `npm run build`
Expected: builder still compiles after the extraction.

### Task 4: Build the portfolio Greeks and simulator UI

**Files:**
- Modify: `frontend/app/portfolio/page.tsx`
- Modify: `frontend/lib/portfolio.ts`
- Modify: `frontend/components/builder/LegsPanel.tsx`

**Step 1: Add the live Greeks section**

Render overall and per-coin Greeks from the backend payload.

**Step 2: Add per-coin simulator tabs**

For the selected coin:
- preload live derivatives legs
- render `MiniChain`, `FuturesBar`, `PnLChart`, and `LegsPanel`
- add `Reset to live positions`

**Step 3: Make legs panel tolerate simulated OKX marks**

If live mark price is not present in option chain data, keep the panel readable rather than showing broken values.

**Step 4: Verify**

Run: `npm run build`
Expected: portfolio route compiles and renders with the new simulator.

### Task 5: Verify the full feature

**Files:**
- No new files required

**Step 1: Run focused verification**

Run:
- `node --test backend/okx-portfolio.test.mjs backend/env-loading.test.mjs`
- `npm run build` in `frontend`

**Step 2: Run one live service check**

Verify the live portfolio payload still returns:
- derivatives positions
- aggregate Greeks

**Step 3: Report actual status**

State only the verified behavior and any remaining gaps.
