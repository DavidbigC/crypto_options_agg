# Analysis Dashboard Redesign

## Goal
Turn `/analysis` into a chart-driven research dashboard for cross-exchange volatility comparison, using the `combined` dataset as the default market view and Deribit, OKX, and Bybit as comparison overlays.

## Scope

In scope:
- Default to `combined` for analysis research
- Keep the page chart-led rather than table-led
- Add exchange overlays and spread-to-combined comparison modes
- Add data freshness and weak-data guardrails
- Add concise in-product guidance and a detailed reference document for chart interpretation

Out of scope:
- `derive` support
- order-entry or execution workflows
- new backend pricing models beyond the current analytics primitives

---

## Problem

The current page is useful for reading one exchange at a time, but it is not yet a strong research surface.

Current limitations:
- exchange comparison requires switching context rather than comparing on the same chart
- the page shows levels but not relative richness versus market consensus
- the raw surface is informative but hard to interpret as a comparison tool
- freshness, data-quality caveats, and missing-expiry states are not surfaced clearly
- the page assumes the user already knows how to interpret smile, skew, term, and surface charts

---

## Product Direction

The redesigned page should answer three research questions quickly:

1. What does the market-wide volatility structure look like?
2. Which venue differs from that market-wide structure?
3. Is the divergence concentrated in tenor, skew, or wings?

To do that, the page should treat `combined` as the anchor dataset and render venue-specific analytics as optional overlays or spreads against that anchor.

---

## Data Model

### Base dataset

- `combined` becomes the default analysis view.
- The page fetches analysis payloads for:
  - `combined`
  - `deribit`
  - `okx`
  - `bybit`

### Alignment rules

- Compare only matching expiries when overlays are enabled.
- If an expiry exists in `combined` but not on a venue, show the gap as missing rather than fabricating interpolation.
- Surface comparison mode should align on the same expiry and bucket key.

### Freshness rules

- Use backend `updatedAt` per exchange payload.
- Show age and stale state for each dataset.
- If a venue is stale or unavailable, keep the base chart visible and mark that overlay as unavailable.

---

## Page Structure

### Controls

- Coin selector remains at the top.
- Default exchange context is replaced with a research control bar:
  - base dataset badge: `Combined`
  - overlay toggles: `Deribit`, `OKX`, `Bybit`
  - comparison mode toggle where relevant: `Level` / `Spread vs Combined`
  - selected expiry control for smile and single-expiry surface drill-down

### Primary charts

1. Smile chart
2. Term structure chart
3. Skew and butterfly chart
4. Surface chart

### Interpretation layer

- Small “How to read this” accordion near the top
- Link to a detailed reference document in `docs/`

---

## Chart Design

### 1. Smile Chart

Purpose:
- Show the cross-section of OTM implied volatility for the selected expiry.

Behavior:
- Anchor series: `combined` SVI fit for the selected expiry
- Overlay series: venue SVI fits for the same expiry
- Raw points:
  - always show combined raw points
  - optionally show raw points for one highlighted comparison venue only, to avoid visual overload

Research use:
- identify which venue is rich or cheap in downside puts, ATM, or calls
- distinguish broad market skew from venue-specific wing dislocations

Guardrails:
- suppress fit overlays for expiries with insufficient points
- mark missing-expiry venue overlays clearly
- show RMSE for each visible fitted curve where available

### 2. Term Structure

Purpose:
- Show how ATM IV evolves across expiries.

Behavior:
- `Level` mode: combined ATM IV curve plus venue ATM IV overlays
- `Spread vs Combined` mode: plot venue minus combined in vol points

Research use:
- identify front-end event risk
- find whether a venue is structurally richer in short tenor or long tenor
- separate broad market repricing from exchange-specific inventory pressure

Guardrails:
- missing expiries should break the line rather than infer values
- stale overlays should be marked in legend state

### 3. Skew and Butterfly

Purpose:
- Show asymmetry and convexity by expiry.

Behavior:
- `Level` mode:
  - combined 25d risk reversal
  - combined 25d butterfly
  - optional venue overlays
- `Spread vs Combined` mode:
  - venue RR spread to combined
  - venue fly spread to combined

Research use:
- compare downside-demand differences across venues
- identify whether divergence is a pure skew story or also a convexity story

Guardrails:
- hide overlays for expiries lacking reliable delta coverage
- make missing data explicit rather than plotting zeros

### 4. Surface

Purpose:
- Show the shape of OTM IV across tenor and moneyness.

Behavior:
- Default: combined heatmap
- Comparison mode:
  - choose one venue at a time
  - color cells by `venue IV - combined IV`
  - hover shows combined IV, venue IV, spread, and contract counts

Research use:
- identify where a venue is rich or cheap by both wing and tenor
- distinguish local anomalies from broad market structure

Guardrails:
- show low-count cells as weaker-confidence states
- do not fill missing cells with neutral colors that imply real data

---

## UX Principles

- Chart-first layout: avoid turning the page into a scanner table
- Combined as consensus: make market-wide shape the first thing visible
- Relative value second: comparison should be one click away, not a separate page
- Low-clutter overlays: only show the extra information needed to support comparison
- Explicit caveats: missing expiries, stale data, weak bucket counts, and missing fits must be visible

---

## Documentation

Two layers of explanation are required.

### In-product guidance

Add a compact “How to read this” panel with short sections for:
- IV smile
- term structure
- skew and butterfly
- raw surface / spread surface

Each section should explain:
- what the chart measures
- what to compare first
- one common interpretation trap

### Full reference document

Create a detailed companion doc covering:
- what each chart means
- how each metric is computed in this codebase
- what normal versus stressed shapes look like
- how to compare venues correctly
- common traps:
  - sparse strikes
  - stale quotes
  - wing distortion from thin markets
  - missing expiries
  - noisy nearest-delta approximations

---

## Backend and Data Quality Notes

The current analytics engine is a workable base, but the redesign should acknowledge its limitations.

Known constraints:
- raw surface cells use average mark IV by bucket
- skew and fly use nearest available 25-delta contracts rather than interpolated points
- ATM uses current fit or nearest strike fallback

The redesign should not hide these constraints. It should surface enough context for users to interpret the charts responsibly.

Possible follow-up improvements after the redesign:
- replace mean bucket IV with median or weighted values
- interpolate 25d points instead of taking nearest contracts
- add confidence metadata for fits and buckets

---

## Testing Strategy

The redesign should include tests for:
- exchange-payload alignment by expiry
- spread-to-combined calculations
- missing overlay handling
- stale dataset state derivation
- surface comparison transform
- interpretation text presence for key user paths

Manual verification should cover:
- BTC, ETH, and SOL
- combined plus each overlay combination
- missing venue expiry cases
- stale or unavailable overlay cases

---

## Success Criteria

The redesign is successful if a user can:
- open `/analysis` and immediately see the market-wide vol structure
- compare a venue against combined without changing pages or mental context
- identify whether divergence is in smile, tenor, skew, or surface
- understand the meaning and limitations of each chart without outside documentation
