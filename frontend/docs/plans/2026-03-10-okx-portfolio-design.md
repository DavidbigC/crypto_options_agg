# OKX Portfolio Page Design

**Date:** 2026-03-10

**Goal:** Add a dedicated portfolio page that shows OKX account totals, balances, and open positions, while shaping the backend contract so additional exchanges can be added later.

## Scope

- Build a new `/portfolio` page.
- Use OKX private REST endpoints to fetch account configuration, balances, and positions.
- Show all account data needed for a portfolio view:
  - account-level summary
  - per-currency balances
  - open positions
- Support manual refresh only for v1.
- Keep credentials server-side only.

## Product Decisions

- Exchange scope: OKX first, but use a normalized backend response that can accommodate other exchanges later.
- Refresh model: load once on page open, plus a manual refresh button.
- Host/environment: use the production OKX private API host at `https://www.okx.com`.
- Permissions: read-only API key.

## Architecture

### Backend

- Add an OKX private REST client responsible for:
  - reading credentials from environment variables
  - signing private requests
  - calling:
    - `GET /api/v5/account/config`
    - `GET /api/v5/account/balance`
    - `GET /api/v5/account/positions`
- Add a portfolio service that converts raw OKX responses into one normalized payload.
- Expose a backend route such as `/api/portfolio/okx`.

### Frontend

- Add a dedicated `/portfolio` page.
- Fetch `/api/portfolio/okx` once on load.
- Render the page in three sections:
  - summary strip
  - balances table
  - positions table
- Add a manual refresh action.

## Response Shape

The backend should return one normalized object with exchange-specific source data hidden behind a stable app contract.

Suggested top-level structure:

```json
{
  "exchange": "okx",
  "account": {
    "label": "options position",
    "permission": "read_only",
    "positionMode": "net_mode",
    "greeksType": "BS",
    "settleCurrency": "USDC"
  },
  "summary": {
    "totalEquityUsd": 5753.18,
    "availableEquityUsd": null,
    "openPositions": 4,
    "balancesCount": 5,
    "updatedAt": "2026-03-10T12:34:56.789Z"
  },
  "balances": [],
  "positions": []
}
```

## UI Design

### Summary Strip

Show:

- exchange label: `OKX`
- account label / permission
- total equity
- available equity when present
- open positions count
- last updated timestamp
- manual refresh button

### Balances Section

Columns:

- currency
- equity
- USD value
- available
- frozen
- unrealized PnL

Behavior:

- sort by USD value descending
- hide tiny dust balances below a small USD threshold by default
- allow the UI to show all balances if needed later

### Positions Section

Show open positions only.

Columns:

- instrument
- type
- margin mode
- size
- average price
- mark price
- unrealized PnL
- unrealized PnL %
- delta
- gamma
- theta
- vega

Behavior:

- use signed size to distinguish long vs short
- default sort by absolute notional / risk relevance
- show balances even when there are no open positions

## Error Handling

- Missing credentials: backend returns a configuration error the page can display cleanly.
- Upstream OKX failure: backend returns a retryable error state.
- Empty positions: page shows the summary and balances sections with an empty positions state.
- Logging must not include secrets.

## Testing

### Backend

- unit tests for normalization of OKX balances and positions
- unit tests for open-position filtering
- unit tests for summary calculations
- tests for missing-credential and upstream-error handling

### Frontend

- render summary, balances, and positions from mocked API data
- render empty positions state
- render backend error state

## Non-Goals For V1

- private WebSocket streaming
- multi-exchange aggregation
- trading actions
- historical portfolio charts
