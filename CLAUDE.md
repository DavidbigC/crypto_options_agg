# Project Guidelines

## Backend vs Frontend Responsibility

**Core principle: if the result is the same for all users, it belongs on the backend.**

The backend is the source of truth for all market-derived computations. The frontend only renders and handles per-user state.

### Move to Backend (same result for every user)
- **SVI fitting** — Nelder-Mead optimization per expiry, cached and refreshed on new data
- **Arb detection** — box spreads, verticals, butterflies, PCP, calendar arbs (all strategies in `lib/strategies/`)
- **Gamma/Vega scanner rankings** — pre-ranked straddle/strangle rows per expiry
- **IV term structure** — ATM IV per expiry
- **25Δ skew & butterfly** — risk reversal and butterfly spreads per expiry
- **IV smile curve** — SVI curve points for charting

Planned backend endpoints:
```
GET /api/analysis/:exchange/:coin     → SVI params + term structure + skew per expiry
GET /api/arbs/:coin                   → precomputed box spreads + all arbs
GET /api/scanners/:exchange/:coin     → gamma/vega scanner rows (pre-ranked)
```

### Keep on Frontend (user-specific)
- Strategy Builder: user's legs, entry prices, qty, P&L simulation, IV stress sliders
- Exchange toggle selection (which exchanges to show)
- Expiration selection (navigation)
- Event date input in scanners (user's own catalyst)
- Black-Scholes P&L/Greeks for user-defined positions

### Why This Matters
The backend may be rewritten in Rust or another high-performance language. By keeping all shared math on the backend, a language swap only requires reimplementing the API endpoints — the frontend stays untouched.

## Multi-User Principle
Never make external API calls per user request. Use background polling + in-memory cache. All users share the same cached data (100 users = same external API load as 1 user).
