# Frontend Features Reference

## Main Page (app/page.tsx)

### State
- `exchange` — bybit | okx | deribit | derive | combined
- `selectedCrypto` — BTC | ETH | SOL
- `selectedExpiration` — selected expiry string (YYYY-MM-DD)
- `optionsData` — accumulated SSE data (all expiries merged)
- `activeExchanges` — Set<ExchangeKey> for combined mode toggles
- `activeScanner` — 'gamma' | 'vega' | null

### SSE Streaming
- Endpoint: `GET /api/stream/:exchange/:coin?expiry=...`
- Each push contains one expiry's data (~30KB vs ~220KB for all)
- Merges into existing data: `prev.data = { ...prev.data, ...data.data }`
- Default expiry selection uses `filterExpirations()` to skip past dates

### Computed (useMemo)
- `boxSpreads`, `allArbs` — only computed for combined exchange
- `arbExpiryStrategies` — map of expiry → Set of strategy types (for tab badges)
- `expiryExchangeCounts` — per-expiry count of contracts per exchange

## Options Chain Components

### OptionsChain.tsx
- Single exchange view
- Columns: Bid | APR | Ask | Δ | Γ | Θ | V | bIV | mIV | aIV | ITM | Strike | ITM | aIV | mIV | bIV | Δ | Γ | Θ | V | Ask | APR | Bid
- APR = `(bid / collateral) × (365/dte) × 100`, ITM APR at opacity-30

### CombinedOptionsChain.tsx
- Multi-exchange merged view
- Shows best bid/ask with exchange badge (B/O/D pill)
- APR columns after Best Bid on each side, ITM at opacity-30
- Box spread highlighting: amber background + LB/SB badge on strike cell
- Exchange toggle buttons filter which exchanges contribute to best bid/ask
- `feesOn` toggle applies per-exchange taker fees

### MiniChain.tsx (builder/MiniChain.tsx)
- Compact chain for strategy builder page
- Click Ask → buy leg, Click Bid → sell leg added to strategy
- APR columns after Bid on each side
- ±5 strikes shown by default, "Show all N" button
- Scroll to ATM on expiry change

## Scanner Components (components/scanners/)

### GammaScanner.tsx
- Metric: `BE/day = √(2|θ|/Γ)` = min daily spot move to cover theta
- Per expiry: ATM straddle + best delta-neutral strangle (|net Δ| < 0.15)
- Long/Short toggle: long uses ask prices + sorts ascending, short uses bid + sorts descending
- Event date: adds `BE→event = √(2N|θ|/Γ)` column, re-sorts by it
- handleLoad: writes legs to localStorage `arb_pending_strategy`, opens /builder in new tab

### VegaScanner.tsx
- Metric: `BE IV move = cost/vega` = vol points IV must expand to break even
- Secondary display: `vega/$` (efficiency info)
- Long/Short toggle: long uses ask + sorts ascending, short uses bid + sorts descending
- Event date: adds `Θ→event = |θ| × daysToEvent` column
- With event: sorts by `thetaToEvent / vega` (theta cost per vega unit)

## Analysis Page (app/analysis/page.tsx)

### Charts
1. **IV Smile** — recharts LineChart, merges 120 SVI curve points + raw scatter
   - Bid/ask as faint gray dots, mark IV as blue dots, SVI fit as violet line
   - Spot price reference line (amber dashed)
   - X-axis: strike, Y-axis: IV %
2. **ATM IV Term Structure** — SVI IV at k=0 per expiry vs DTE
3. **25Δ Skew & Butterfly** — bar chart, requires delta data
   - RR = `IV(25Δ call) - IV(25Δ put)` (negative = put premium = crash fear)
   - BF = `(IV(25Δ call) + IV(25Δ put))/2 - ATM IV` (positive = fat tails)

### Data preparation for SVI
- Uses OTM calls (strike ≥ spot) and OTM puts (strike ≤ spot) for fitting
- `k = log(strike / spotPrice)`, `w = markVol² × T`
- T in years: `(expiry_ms - now_ms) / (365.25 × 24 × 3600 × 1000)` — NEVER use shortcuts here

## Strategy Builder (app/builder/)

### PnLChart.tsx
- ReferenceArea for profit zone (y1=0, fillOpacity=0.04 green) and loss zone (y2=0, red)
- Zero line: solid, slightly thicker than grid lines
- Same treatment for Greeks sub-charts

### P&L Calculation
- `entryPrice` stored in USD for all exchanges (OKX converted at leg creation time)
- `contractSize` per exchange/coin: e.g. OKX BTC = 0.1 BTC/contract
- P&L = (currentPrice - entryPrice) × contractSize × qty × direction

## APR Formula
```
callAPR = (bestBid / spotPrice) × (365 / dte) × 100   // % annualised
putAPR  = (bestBid / strike)    × (365 / dte) × 100
```
ITM options: APR shown at opacity-30 (less meaningful to sell ITM)

## BE/day Formula (Gamma Scanner)
```
BE = √(2 × |theta| / gamma)   // in USD, min daily move to cover theta
```
Derived from: gamma scalping P&L = 0.5 × gamma × move² per day must cover |theta|.

## BE IV Move Formula (Vega Scanner)
```
BE_IV = cost / vega × 100   // in vol points %
```
Derived from: vega × IV_change = cost → IV_change = cost/vega.

## SVI No-Arbitrage Constraints
- b ≥ 0
- |ρ| < 1
- σ > 0
- a + b × σ × √(1-ρ²) ≥ 0  (ensures w(k) ≥ 0 everywhere)
