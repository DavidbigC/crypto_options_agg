# OKX Portfolio Greeks And Simulator Design

**Date:** 2026-03-10

**Goal:** Extend the portfolio page with live derivatives Greeks and a read-only-but-editable simulator seeded from live OKX derivatives positions.

## Scope

- Show live aggregate Greeks for the current OKX derivatives book.
- Show per-coin Greek breakdown.
- Seed a simulator from current OKX derivatives positions.
- Include OKX options plus futures/perpetuals.
- Exclude spot balances from the simulator.
- Allow hypothetical legs on top of imported live positions.
- Keep refresh and simulator edits separate with an explicit reset action.

## Key Constraint

P&L simulation needs a single spot axis, so the simulator must run per underlying coin. Live Greeks can still be aggregated across the whole derivatives book.

## Backend

- Extend normalized OKX positions with parsed instrument metadata:
  - coin
  - kind (`option`, `future`, `swap`)
  - expiry
  - strike
  - option type when relevant
  - reference underlying price
- Return live Greek aggregates:
  - overall totals
  - per-coin totals

## Frontend

- Keep balances informational only.
- Add a `Derivatives Greeks` section to the portfolio page.
- Add simulator tabs per coin.
- Initialize local simulator legs from the live portfolio payload.
- Reuse existing builder-style `Leg`, `LegsPanel`, and `PnLChart` logic where possible.
- Allow adding hypothetical options and futures/perps for the selected coin.

## Simulation Behavior

- Imported live positions become editable local legs.
- Manual refresh updates the live portfolio data only.
- `Reset to live positions` repopulates simulator legs from the latest fetched payload.
- Options use Black-Scholes pricing and Greeks.
- Futures/perps use linear P&L and delta only.

## Non-Goals

- Trading or order placement
- Spot-position simulation
- Cross-coin single-chart simulation
