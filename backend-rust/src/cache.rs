use std::collections::HashMap;
use serde::{Deserialize, Serialize};

// ---- Bybit ----
// coin ("BTC"/"ETH"/"SOL") -> symbol -> raw ticker JSON
pub type BybitTickerCache = HashMap<String, HashMap<String, serde_json::Value>>;
// coin -> spot price
pub type BybitSpotCache = HashMap<String, f64>;

// ---- OKX ----
// instFamily ("BTC-USD"/"ETH-USD") -> instId -> Greeks JSON
pub type OkxGreeksCache = HashMap<String, HashMap<String, serde_json::Value>>;
// instFamily -> instId -> ticker JSON (bid/ask prices)
pub type OkxTickerCache = HashMap<String, HashMap<String, serde_json::Value>>;
// instId ("BTC-USDT"/"ETH-USDT") -> spot price
pub type OkxSpotCache = HashMap<String, f64>;

// ---- Deribit ----
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeribitCoinCache {
    pub summaries: Vec<serde_json::Value>,
    pub spot: f64,
}
// coin -> DeribitCoinCache
pub type DeribitCache = HashMap<String, DeribitCoinCache>;
// instrumentName -> Greeks JSON
pub type DeribitGreeksCache = HashMap<String, serde_json::Value>;

// ---- Derive ----
// instrumentName -> slim ticker JSON
pub type DeriveTickersCache = HashMap<String, serde_json::Value>;
// currency ("BTC"/"ETH") -> spot price
pub type DeriveSpotCache = HashMap<String, f64>;

// ---- Binance ----
// coin -> symbol -> ticker JSON
pub type BinanceCache = HashMap<String, HashMap<String, serde_json::Value>>;
pub type BinanceSpotCache = HashMap<String, f64>;

// ---- Futures ----
// coin -> list of futures rows
pub type FuturesCache = HashMap<String, Vec<serde_json::Value>>;

// ---- Derived/Analysis ----
pub type AnalysisCache = HashMap<String, serde_json::Value>;
pub type ArbCache = HashMap<String, serde_json::Value>;
pub type ScannerCache = HashMap<String, serde_json::Value>;

// ---- Derive viewer count (demand-driven WS) ----
// currency -> number of active SSE viewers
pub type DeriveViewerCount = HashMap<String, usize>;
