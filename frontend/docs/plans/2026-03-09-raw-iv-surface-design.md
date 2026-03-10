# Raw IV Surface Design

**Feature:** Backend-computed raw mark-IV volatility surface for the analysis page

**Goal:** Add a new analysis chart that shows the implied-volatility surface directly from raw `markVol` option data, without using the existing SVI fit.

**Scope:** This change spans the backend API in `/Users/davidc/Scripts/binance options/backend` and the analysis UI in `/Users/davidc/Scripts/binance options/frontend`.

## Problem

The current analysis page already shows:

- per-expiry IV smiles, with optional SVI fit
- ATM term structure
- skew metrics

What is missing is a multi-expiry view built from the observed market IVs themselves. The user explicitly wants to avoid the SVI-fitted curve for this chart and instead inspect raw `markVol` data across expiries.

Raw exchange strikes are irregular across maturities, so plotting raw strike on one axis and expiry on the other would produce a sparse, jagged chart that is hard to interpret and easy to misread. The design should preserve raw IV input while normalizing the strike dimension enough to make the surface readable.

## Proposed Approach

Compute a backend `rawSurface` dataset from the existing option chains:

- Filter to future expiries only.
- Use raw `markVol` from the chain.
- Normalize each option by moneyness relative to spot at computation time.
- Bucket points into fixed moneyness bands so strikes from different expiries align on one shared y-axis.
- Aggregate each bucket to one IV value per expiry using a simple average of valid raw mark IVs.

The frontend will render this as a heatmap-like matrix under the analysis page. This is still a raw-data chart because the values come from market `markVol`; the only transformation is moneyness normalization plus bucketing to make expiries comparable.

## Data Model

Add a `rawSurface` payload to the backend analysis response with this logical shape:

- `x`: ordered expiry labels / metadata
- `y`: ordered moneyness buckets
- `cells`: one cell per `(expiry, bucket)` with aggregated IV and supporting metadata

Planned fields:

- `exp`: expiry date string
- `label`: short display label
- `dte`: days to expiry
- `bucketKey`: numeric bucket center in log-moneyness or moneyness percent
- `bucketLabel`: display label for axis/ticks
- `avgMarkIV`: aggregated raw IV in percent
- `count`: number of raw contracts contributing to the cell
- `minStrike`
- `maxStrike`

## Axis Choice

Use `log-moneyness = ln(strike / spot)` internally for bucketing.

Reasoning:

- It is stable across BTC/ETH/SOL price levels.
- It aligns strikes above and below spot symmetrically.
- It avoids a distorted y-axis when spot changes materially.

The UI can still present friendly labels such as:

- `ATM`
- `-10%`
- `+10%`

derived from the bucket center.

## Contract Selection

Use OTM-only raw contracts by default:

- calls with `strike >= spot`
- puts with `strike <= spot`

Reasoning:

- It matches the existing smile logic.
- It avoids duplicate call/put representations around the same strike.
- OTM options usually provide the cleaner volatility quote for surface inspection.

If a future enhancement is needed, the payload can include both-all-contracts and OTM-only modes, but that is out of scope here.

## Aggregation

For each expiry:

1. collect valid OTM contracts with `markVol > 0`
2. compute log-moneyness
3. assign each contract to a fixed bucket
4. compute mean IV in percent for the bucket

Keep aggregation intentionally simple:

- no interpolation
- no fitting
- no smoothing beyond bucketing

This preserves the user’s request for a raw-data-based chart.

## UI Design

Add a new card to the analysis page under the existing smile section or near the term-structure/skew section:

- Title: `Raw IV Surface`
- Subtitle: `OTM mark IV bucketed by moneyness and expiry`

Render:

- x-axis: expiry
- y-axis: moneyness bucket
- color intensity: `avgMarkIV`

Tooltip should show:

- expiry
- DTE
- bucket label
- average mark IV
- number of contributing contracts
- strike range in that bucket

## Error Handling

If there is insufficient data:

- omit empty cells
- show an empty-state message when no surface data exists

If a specific expiry has too few valid contracts:

- include only the buckets that have data
- do not fabricate values

## Testing

Backend:

- unit test raw-surface computation from a small synthetic chain
- verify OTM filtering
- verify bucket assignment and aggregation
- verify future-expiry filtering

Frontend:

- verify analysis page accepts the new payload shape
- verify empty-state rendering
- verify chart data transforms are stable

## Notes

- This design deliberately avoids SVI interpolation for the new chart.
- The backend owns all surface computation so the frontend remains presentation-only.
- The output is a raw-data surface view, not a fitted or arbitrage-clean vol surface.
