# Derive Demand-Driven Subscriptions

## Goal
Only maintain Derive WS connection when at least one SSE client is viewing.
Disconnect when last viewer leaves. Keep caches warm so reconnects are fast (~300ms, not 3-6s).

## Design

### Reference counting
Module-level `viewerCounts = {}` per currency (BTC, ETH independently).
- Total viewers = sum across all currencies.
- WS is open ↔ total viewers > 0.

### WS lifecycle
- **First viewer of any currency** (total 0→1): open WS connection.
- **Last viewer of all currencies** (total 1→0): intentionally close WS. No reconnect.
- **Unexpected close** (network drop, exchange): reconnect with exponential backoff.
- **On open**: subscribe channels for all currencies with viewerCount > 0.

Distinguish intentional vs unexpected close via a flag: `let _intentionalClose = false`.

### Cache strategy — keep both caches warm
- `instrumentsByurrency = {}` — instrument name lists (kept forever after first fetch)
- `deriveTickersCache` (existing) — ticker data (kept, just stops updating when WS closes)

On reconnect:
- If `instrumentsByurrency[currency]` exists → skip REST name fetch
- If `deriveTickersCache` has entries for currency → skip bootstrap REST calls
- Jump straight to subscribing channels → ~300ms reconnect instead of 3-6s

### Per-currency subscription changes on existing WS
- New currency gets first viewer while WS already open → subscribe that currency's channels
- Currency loses last viewer while others still active → unsubscribe that currency's channels

---

## Files

### `backend/lib/derive-ws.js`

Remove `startDeriveWS()` export — replace with demand-driven API:

**New exports:**
```js
export function addDeriveViewer(currency)     // call on SSE connect
export function removeDeriveViewer(currency)  // call on SSE disconnect
```

**Module-level state:**
```js
const viewerCounts     = {}  // { BTC: 0, ETH: 0, ... }
const instrumentsCache = {}  // { BTC: [...names], ETH: [...names] } — kept warm
let _ws                = null
let _intentionalClose  = false
let _reconnectDelay    = RECONNECT_BASE
```

**`addDeriveViewer(currency)`:**
1. Increment `viewerCounts[currency]`
2. If total was 0 → open WS (`_connect()`)
3. Else if WS already open → subscribe channels for this currency immediately

**`removeDeriveViewer(currency)`:**
1. Decrement `viewerCounts[currency]`
2. If this currency still has other viewers → nothing
3. If this currency hit 0 but others still active → unsubscribe this currency's channels
4. If total hit 0 → `_intentionalClose = true`, close WS

**`_connect()`:**
- Opens WS, sets up message handler (same as today)
- On open: subscribe all currencies with viewerCount > 0 (via `_subscribeForCurrency`)
- On close: if `_intentionalClose` → stop. Else reconnect with backoff.

**`_subscribeForCurrency(currency)`:**
1. Fetch instrument names if not in `instrumentsCache` (REST call)
2. Bootstrap tickers if `deriveTickersCache` has no entries for currency (REST calls)
3. Send subscribe messages (fast .100 / slow .1000 tiering — same as today)

**`_unsubscribeForCurrency(currency)`:**
1. Build channel list from `instrumentsCache[currency]`
2. Send unsubscribe messages in CHUNK batches

### `backend/server.js`

1. Remove `import { startDeriveWS }` — replace with `addDeriveViewer`, `removeDeriveViewer`
2. Remove `startDeriveWS()` call at startup
3. In `GET /api/stream/:exchange/:coin`:
   - On connect: `if (exchange === 'derive') addDeriveViewer(coin)`
   - In `req.on('close')`: `if (exchange === 'derive') removeDeriveViewer(coin)`

---

## Checklist

### `derive-ws.js`
- [ ] Add `viewerCounts`, `instrumentsCache`, `_ws`, `_intentionalClose`, `_reconnectDelay` vars
- [ ] Export `addDeriveViewer(currency)`: increment, open WS or subscribe currency on existing WS
- [ ] Export `removeDeriveViewer(currency)`: decrement, unsubscribe currency or close WS
- [ ] `_connect()`: open WS, on open subscribe all active currencies, on close handle intentional vs unexpected
- [ ] `_subscribeForCurrency(currency)`: fetch names if not cached, bootstrap if cache empty, send subscribe
- [ ] `_unsubscribeForCurrency(currency)`: send unsubscribe messages from instrumentsCache
- [ ] Remove old `startDeriveWS()` export and `CURRENCIES` constant

### `server.js`
- [ ] Replace `startDeriveWS` import with `addDeriveViewer`, `removeDeriveViewer`
- [ ] Remove `startDeriveWS()` call
- [ ] Add `addDeriveViewer(coin)` on SSE connect for derive
- [ ] Add `removeDeriveViewer(coin)` on SSE close for derive
- [ ] Remove `setDeriveUpdateCallback` wiring (callback export stays in derive-ws, wiring stays)
