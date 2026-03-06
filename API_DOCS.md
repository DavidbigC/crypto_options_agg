# API Documentation

This project uses two data sources for crypto options market data: **Bybit REST API** (used by the web app backend) and **OKX WebSocket API** (used by the standalone live-data script).

---

## Bybit REST API

### Overview

Bybit's V5 REST API is a request/response HTTP API. You make a GET request, it returns a snapshot of data at that moment. The web app backend (`backend/server.js`) calls it on demand whenever the frontend requests data.

- **Base URL:** `https://api.bybit.com/v5`
- **Auth required:** No — all endpoints used here are public market data
- **Rate limits:** Public endpoints are generous (120 requests/second for market data)

### Endpoints Used

#### 1. Get Options Tickers
Returns live market data for all option contracts of a given coin — bid, ask, last price, volume, and Greeks.

```
GET /market/tickers?category=option&baseCoin=BTC
```

**Key response fields per contract:**
| Field | Description |
|---|---|
| `symbol` | Contract ID e.g. `BTC-27MAR26-70000-C` |
| `bid1Price` | Best bid price |
| `ask1Price` | Best ask price |
| `lastPrice` | Last traded price |
| `volume24h` | 24h volume |
| `openInterest` | Open interest |
| `markPrice` | Mark price (used for margin/liquidation) |
| `delta` | How much option price moves per $1 move in spot |
| `gamma` | Rate of change of delta |
| `theta` | Daily time decay (negative = option loses value each day) |
| `vega` | Sensitivity to implied volatility changes |
| `impliedVolatility` | Implied volatility of the option |

#### 2. Get Spot Price
Returns the current spot price for a trading pair.

```
GET /market/tickers?category=spot&symbol=BTCUSDT
```

**Key response fields:**
| Field | Description |
|---|---|
| `lastPrice` | Current spot price |
| `price24hPcnt` | 24h price change percentage |
| `volume24h` | 24h volume |

#### 3. Get Instruments Info
Returns static metadata about all available option contracts — strikes, expiry dates, lot sizes.

```
GET /market/instruments-info?category=option&baseCoin=BTC
```

Use this to get the full list of available strikes and expiries without needing live ticker data.

#### 4. Multiple Spot Prices
The client calls `getSpotPrice` in parallel for BTC, ETH, SOL using `Promise.allSettled`.

### Symbol Format

Bybit option symbols follow this pattern:

```
BTC-27MAR26-70000-C
 ^     ^      ^   ^
 |     |      |   └── C = Call, P = Put
 |     |      └────── Strike price ($70,000)
 |     └───────────── Expiry date (27 March 2026)
 └─────────────────── Underlying asset
```

Date format is `DDMMMYY` (e.g. `27MAR26`) or `DMMMYY` for single-digit days (e.g. `5SEP25`).

### How the Web App Uses It

1. Frontend requests `/api/options/BTC`
2. Backend calls Bybit `/market/tickers?category=option&baseCoin=BTC`
3. Backend parses each symbol to extract expiry/strike/type
4. Groups options by expiry date into `{ calls: [], puts: [] }`
5. Returns sorted data to the frontend

### Fallback Behaviour

If the Bybit API is unreachable, the backend falls back to mock data (`backend/lib/mock-data.js`) so the frontend doesn't break.

---

## OKX WebSocket API

### Overview

OKX's WebSocket API is a persistent connection that pushes live data to you as it changes — no polling needed. Once you subscribe to a channel, OKX sends updates automatically (every ~200ms for options data).

- **Public WS URL:** `wss://ws.okx.com:8443/ws/v5/public`
- **Auth required:** No — `opt-summary` is a public channel
- **Heartbeat:** You must send `ping` every 25–30 seconds or the connection closes

### The `opt-summary` Channel

This is the main channel used in `okx_options_ws.py`. It pushes live Greeks and implied volatility data for all options in a given instrument family.

**Subscribe message:**
```json
{
  "op": "subscribe",
  "args": [
    {
      "channel": "opt-summary",
      "instFamily": "BTC-USD"
    }
  ]
}
```

**instFamily values:** `BTC-USD`, `ETH-USD`, `SOL-USD`

**Data pushed per contract:**
| Field | Description |
|---|---|
| `instId` | Contract ID e.g. `BTC-USD-250328-70000-C` |
| `instType` | Always `OPTION` |
| `delta` | Delta Greek |
| `gamma` | Gamma Greek |
| `theta` | Theta Greek (daily time decay) |
| `vega` | Vega Greek |
| `markVol` | Mark implied volatility |
| `bidVol` | Bid implied volatility |
| `askVol` | Ask implied volatility |
| `realVol` | Realised volatility |
| `fwdPx` | Forward price of the underlying |
| `ts` | Timestamp of the data (milliseconds) |

### Symbol Format

OKX option symbols follow this pattern:

```
BTC-USD-250328-70000-C
  ^   ^    ^     ^   ^
  |   |    |     |   └── C = Call, P = Put
  |   |    |     └────── Strike price ($70,000)
  |   |    └──────────── Expiry date (28 March 2025, YYMMDD)
  |   └───────────────── Quote currency
  └───────────────────── Underlying asset
```

### How the Connection Works

1. Open WebSocket to `wss://ws.okx.com:8443/ws/v5/public`
2. Send subscribe message for `opt-summary` + `instFamily: BTC-USD`
3. OKX confirms with `{"event": "subscribe", ...}`
4. OKX begins pushing data — first a full snapshot of all contracts, then incremental updates
5. Send `ping` every 25s, OKX responds with `pong` — keeps connection alive

### Heartbeat

OKX will drop the connection after ~30 seconds of silence. The script handles this automatically:

```python
await ws.send("ping")   # send every 25s
# OKX responds with "pong"
```

### Running the Script

Install dependencies:
```bash
pip install websockets tabulate
```

Run:
```bash
python okx_options_ws.py
```

The script will display a live table of all BTC option contracts, grouped by expiry, updating as OKX pushes new data.

---

## Comparison

| | Bybit REST | OKX WebSocket |
|---|---|---|
| Transport | HTTP request/response | Persistent TCP connection |
| Data freshness | On-demand snapshot | Live push (~200ms updates) |
| Auth required | No | No (public channels) |
| Used in | Web app backend | Standalone Python script |
| Greeks source | Bybit's own calculation | OKX's own calculation |
| Bid/ask prices | Yes (`bid1Price`, `ask1Price`) | Via IV (`bidVol`, `askVol`) |
