# Research: Frontend Update Latency

## Data Flow
```
Exchange APIs → Rust backend (poll/WS) → SSE broadcast channel → Next.js proxy → Browser EventSource
```

## Bottleneck 1: Next.js SSE Proxy Route (ALL exchanges)

**Impact: HIGH — affects every exchange equally**

The frontend has TWO mechanisms to reach the backend:
1. `next.config.js` rewrite: `/api/:path*` → `http://localhost:3501/api/:path*` (HTTP-level proxy, streams properly)
2. `app/api/stream/[...params]/route.ts` — a Next.js API route handler that manually proxies SSE

**Next.js App Router gives API routes priority over rewrites.** So all SSE requests hit the route handler, which does:

```js
const backendResponse = await fetch(backendUrl.toString(), ...)
return new Response(backendResponse.body, ...)
```

This pipes the SSE stream through Node.js's internal `fetch` (undici) → `ReadableStream` → Next.js response pipeline. Even with `Content-Encoding: identity`, `compress: false`, and `X-Accel-Buffering: no`, undici and Next.js buffer chunks internally before flushing. This adds **500ms–3s+ latency** to every SSE event.

**Fix**: Delete `frontend/app/api/stream/[...params]/route.ts`. The rewrite in `next.config.js` already handles the proxy at the HTTP level, which streams properly without buffering.

## Bottleneck 2: Deribit REST Polls Every 5s

**Impact: HIGH for Deribit only**

`deribit.rs:58` — `sleep(Duration::from_secs(5))`. Each poll cycle makes 2 HTTP requests per coin (spot + book summaries), then broadcasts. With 3 coins (BTC, ETH, SOL), that's 6 requests per 5s cycle.

At 1s polling: 6 req/s. Deribit's public API rate limit is generous (~20 req/s for non-authenticated), so this is safe.

**Fix**: Change `sleep(Duration::from_secs(5))` to `sleep(Duration::from_secs(1))`.

Note: Deribit WS (`handle_ws_message`) receives real-time greeks updates but only caches them — it doesn't trigger SSE broadcast. Greeks are picked up on the next REST poll. At 1s polling this is acceptable.

## Bottleneck 3: Derive Broadcasts on EVERY WS Message (Flooding)

**Impact: MEDIUM — Derive + Combined view**

`derive.rs:handle_ws_message` does this on **every single WS ticker update**:
1. Updates cache (fast)
2. Calls `build_response()` — rebuilds FULL response for that currency (iterates all cached tickers)
3. Serializes to JSON string
4. Broadcasts via SSE
5. Calls `combined::broadcast_update()` — rebuilds FULL combined response (reads ALL 5 exchange caches, merges)
6. Serializes combined to JSON string
7. Broadcasts combined via SSE

With 100ms subscriptions for the first 4 expiries and hundreds of instruments, this means:
- Hundreds of full response rebuilds per second per currency
- Hundreds of full combined rebuilds per second per currency
- SSE broadcast channel capacity is only 16 — clients receive `Lagged` errors and miss messages
- Massive CPU waste from repeated serialization

**Fix**: Throttle Derive broadcasts. Instead of broadcasting in `handle_ws_message`:
- Set an `AtomicBool` dirty flag per currency
- A periodic flush task (every 200ms) checks dirty flags and broadcasts if set
- This coalesces rapid WS updates into ~5 broadcasts/s instead of hundreds

## Bottleneck 4 (minor): combined::broadcast_update on every exchange update

Every exchange calls `combined::broadcast_update()` after its own broadcast. This reads all 5 exchange caches and merges them. At current rates (Bybit 1/s, OKX 1/s, Deribit 1/5s per coin, Derive hundreds/s), the Derive flooding is the main problem. Once Derive is throttled, combined broadcasts happen ~3-4x/s per coin which is fine.

## Polling/Broadcast Intervals Summary

| Exchange | Source   | Current Interval | SSE Broadcast Trigger |
|----------|----------|------------------|-----------------------|
| Bybit    | REST     | 1s               | After each poll ✅     |
| OKX      | WS+REST  | WS=real-time, REST=1s | After REST poll ✅  |
| Deribit  | WS+REST  | WS=100ms, REST=5s | After REST poll ❌ (5s too slow) |
| Derive   | WS       | 100ms/1000ms     | Every WS message ❌ (floods) |
| Binance  | WS       | real-time        | On WS message ✅      |

## What's NOT the Problem

- Backend SSE broadcast mechanism itself (tokio broadcast channel) — instant
- Rust backend HTTP serving (axum) — fast
- React rendering — not a factor at these update rates
- `compress: false` in next.config.js — already disabled
