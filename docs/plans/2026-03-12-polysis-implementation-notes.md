# Polysis Implementation Notes

## Backend route pattern

Follow the existing backend REST pattern in [server.js](/Users/davidc/Scripts/binance%20options/backend/server.js):

- expose a dedicated JSON route under `/api/...`
- validate route params at the edge
- keep route handlers thin
- move Polymarket fetching, filtering, and normalization into a backend library module

Recommended route shape for MVP:

- `GET /api/polymarket/:asset/:horizon`

Recommended backend module split:

- `backend/lib/polymarket/client.js`
- `backend/lib/polymarket/normalize.js`
- `backend/lib/polymarket/service.js`

That matches the current separation where `server.js` wires routes and cache updates while data-specific logic lives in `backend/lib`.

## Frontend route pattern

Follow the existing standalone page pattern in [page.tsx](/Users/davidc/Scripts/binance%20options/frontend/app/analysis/page.tsx):

- build a self-contained route under `frontend/app/polysis/page.tsx`
- fetch backend JSON directly from the page
- keep chart transformation helpers in `frontend/lib`
- keep response typing in `frontend/types`

Recommended frontend additions:

- `frontend/app/polysis/page.tsx`
- `frontend/lib/polysis.ts`
- `frontend/types/polysis.ts`

## Reusable primitives

Reuse selectively from the existing analysis surface:

- navigation pattern in [Header.tsx](/Users/davidc/Scripts/binance%20options/frontend/components/Header.tsx)
- freshness/status treatment from [analysisComparison.js](/Users/davidc/Scripts/binance%20options/frontend/lib/analysisComparison.js)
- chart layout conventions and control structure from [page.tsx](/Users/davidc/Scripts/binance%20options/frontend/app/analysis/page.tsx)

Potentially reusable later:

- options-side expected-move or skew comparison logic if exposed cleanly
- chart components already used by `/analysis` where the visual grammar fits

## Keep isolated

Do not couple `polysis` to the existing options chain table or exchange switching state.

Keep untouched unless a later task proves otherwise:

- [analysis.js](/Users/davidc/Scripts/binance%20options/backend/lib/analysis.js) core options analysis math
- [analysisComparison.js](/Users/davidc/Scripts/binance%20options/frontend/lib/analysisComparison.js) existing options comparison helpers beyond narrow reuse
- main options chain pages and exchange selector flow

`/polysis` should consume existing options analytics as a comparison input, not reshape those systems.
