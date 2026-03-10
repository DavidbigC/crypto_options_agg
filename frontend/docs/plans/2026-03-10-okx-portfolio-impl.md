# OKX Portfolio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a manual-refresh portfolio page that shows OKX account summary, balances, and open positions through a backend-normalized API contract.

**Architecture:** Add a small OKX private REST client and portfolio normalization service in the backend, expose a single `/api/portfolio/okx` route, then render a dedicated `/portfolio` page in the frontend that fetches and displays the normalized payload. Keep exchange-specific logic in the backend so the frontend stays reusable for future exchanges.

**Tech Stack:** Node.js, Express, native `fetch`, Node `node:test`, Next.js 14, React, TypeScript, Tailwind CSS

---

### Task 1: Add failing backend tests for the normalized portfolio contract

**Files:**
- Create: `backend/okx-portfolio.test.mjs`
- Create: `backend/lib/okx-portfolio.js`

**Step 1: Write the failing test**

Add tests that define the expected normalized shape and error handling:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createOkxPortfolioService,
  normalizeOkxPortfolio,
} from './lib/okx-portfolio.js'

test('normalizeOkxPortfolio returns summary, balances, and open positions only', () => {
  const result = normalizeOkxPortfolio({
    configPayload: { data: [{ label: 'options', perm: 'read_only', posMode: 'net_mode', greeksType: 'BS', settleCcy: 'USDC' }] },
    balancePayload: { data: [{ totalEq: '1000', details: [{ ccy: 'ETH', eq: '2', eqUsd: '500', availBal: '1.5', frozenBal: '0.5', upl: '0.1' }] }] },
    positionsPayload: { data: [{ instId: 'ETH-USD-260320-2500-C', instType: 'OPTION', pos: '-2', avgPx: '0.01', markPx: '0.02', upl: '0.5', uplRatio: '0.25', deltaBS: '0.1', gammaBS: '0.2', thetaBS: '-0.3', vegaBS: '0.4', mgnMode: 'cross', notionalUsd: '4000' }, { instId: 'ETH-USD-260320-2500-C', pos: '0' }] },
  })

  assert.equal(result.exchange, 'okx')
  assert.equal(result.summary.openPositions, 1)
  assert.equal(result.balances.length, 1)
  assert.equal(result.positions.length, 1)
})

test('createOkxPortfolioService throws when credentials are missing', async () => {
  const service = createOkxPortfolioService({ env: {}, fetchImpl: async () => { throw new Error('should not fetch') } })
  await assert.rejects(() => service.fetchPortfolio(), /missing okx credentials/i)
})
```

**Step 2: Run test to verify it fails**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: FAIL because `backend/lib/okx-portfolio.js` does not exist yet.

**Step 3: Write minimal implementation**

Create `backend/lib/okx-portfolio.js` with:
- `createOkxPortfolioService({ env, fetchImpl })`
- `normalizeOkxPortfolio({ configPayload, balancePayload, positionsPayload, now })`
- helpers for number parsing, open-position filtering, and sorting

**Step 4: Run test to verify it passes**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: PASS

### Task 2: Expose the backend OKX portfolio endpoint

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/lib/okx-portfolio.js`

**Step 1: Write the failing test**

Extend `backend/okx-portfolio.test.mjs` with a service test that stubs `fetch` and verifies:
- requests hit `https://www.okx.com`
- `account/config`, `account/balance`, and `account/positions` are all requested
- `x-simulated-trading` is only sent for demo mode
- the returned payload includes `summary.updatedAt`

```js
test('fetchPortfolio signs requests and combines the three OKX account endpoints', async () => {
  const seen = []
  const service = createOkxPortfolioService({
    env: { OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p' },
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers })
      return { ok: true, status: 200, json: async () => ({ code: '0', data: [] }) }
    },
  })

  await service.fetchPortfolio()

  assert.equal(seen.length, 3)
  assert.match(seen[0].url, /https:\/\/www\.okx\.com\/api\/v5\/account\//)
})
```

**Step 2: Run test to verify it fails**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: FAIL because the service does not yet perform signed requests.

**Step 3: Write minimal implementation**

Update `backend/lib/okx-portfolio.js` to:
- read either standardized `OKX_*` env vars or the current legacy names as fallback
- sign requests with OKX headers
- call the three account endpoints
- throw readable errors for missing credentials, non-OK HTTP responses, and non-zero OKX codes

Update `backend/server.js` to:
- import the OKX portfolio service
- instantiate it once from `process.env`
- add `GET /api/portfolio/okx`
- return `503` for missing credentials and `502` for upstream OKX failures

**Step 4: Run test to verify it passes**

Run: `node --test backend/okx-portfolio.test.mjs`
Expected: PASS

### Task 3: Build the frontend portfolio page

**Files:**
- Create: `frontend/app/portfolio/page.tsx`
- Create: `frontend/lib/portfolio.ts`
- Modify: `frontend/components/Header.tsx`

**Step 1: Write the failing test**

Because this repo does not have a frontend test runner configured, define the page contract through a small pure helper in `frontend/lib/portfolio.ts` and add a Node test if needed later. For this task, use the backend contract and keep UI logic minimal:
- `getTopBalances(balances, dustThresholdUsd)`
- `sortPositionsByNotional(positions)`

If a small Node test is added, run it first; otherwise keep the UI behavior thin and driven by backend data.

**Step 2: Write minimal implementation**

Add `/portfolio` page that:
- fetches `http://localhost:3500/api/portfolio/okx` on mount
- shows loading, error, and success states
- renders summary cards, balances table, and positions table
- includes a manual refresh button

Update `Header.tsx` to add a `Portfolio` link without changing the existing exchange selector behavior.

**Step 3: Run focused verification**

Run:
- `npm run build` in `frontend`

Expected: build succeeds or any pre-existing unrelated failure is identified separately from this feature.

### Task 4: Verify end-to-end behavior against the live OKX account

**Files:**
- No new files required unless a small note is needed in the plan doc

**Step 1: Start from the implemented backend route**

Run:
- `node --test backend/okx-portfolio.test.mjs`
- `npm run build` in `frontend`
- optional live check: request `http://localhost:3500/api/portfolio/okx` while the backend is running

**Step 2: Verify expected behavior**

Confirm:
- summary contains total equity and updated timestamp
- balances are sorted by USD value
- only non-zero positions appear
- portfolio page can refresh without a full page reload

**Step 3: Report actual status**

If all commands pass, report the portfolio feature as implemented with exact verification evidence. If any command fails, report the failure precisely and stop claiming completion.
