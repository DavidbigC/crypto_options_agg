use crate::cache::*;
use crate::sse::SseSenders;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct AppState {
    pub bybit_ticker: Arc<RwLock<BybitTickerCache>>,
    pub bybit_spot: Arc<RwLock<BybitSpotCache>>,

    pub okx_greeks: Arc<RwLock<OkxGreeksCache>>,
    pub okx_ticker: Arc<RwLock<OkxTickerCache>>,
    pub okx_spot: Arc<RwLock<OkxSpotCache>>,

    pub deribit: Arc<RwLock<DeribitCache>>,
    pub deribit_greeks: Arc<RwLock<DeribitGreeksCache>>,

    pub derive_tickers: Arc<RwLock<DeriveTickersCache>>,
    pub derive_spot: Arc<RwLock<DeriveSpotCache>>,
    pub derive_viewers: Arc<RwLock<DeriveViewerCount>>,

    pub binance: Arc<RwLock<BinanceCache>>,
    pub binance_spot: Arc<RwLock<BinanceSpotCache>>,

    pub futures: Arc<RwLock<FuturesCache>>,

    pub analysis: Arc<RwLock<AnalysisCache>>,
    pub arbs: Arc<RwLock<ArbCache>>,
    pub scanners: Arc<RwLock<ScannerCache>>,

    // SSE broadcast channels: key = "exchange:coin" (e.g., "bybit:BTC")
    pub sse_senders: SseSenders,

    // Polymarket
    pub polymarket_prices: Arc<RwLock<PolymarketPriceCache>>,
    pub polymarket_discovery: Arc<RwLock<PolymarketDiscoveryCache>>,
    pub polymarket_oi: Arc<RwLock<PolymarketOiCache>>,
    pub polymarket_token_asset: Arc<RwLock<PolymarketTokenAssetMap>>,

    // Derive broadcast throttle: dirty flags per currency
    pub derive_dirty: HashMap<&'static str, AtomicBool>,

    // Shared HTTP client for route handlers
    pub http_client: reqwest::Client,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            bybit_ticker: Arc::new(RwLock::new(HashMap::new())),
            bybit_spot: Arc::new(RwLock::new(HashMap::new())),
            okx_greeks: Arc::new(RwLock::new(HashMap::new())),
            okx_ticker: Arc::new(RwLock::new(HashMap::new())),
            okx_spot: Arc::new(RwLock::new(HashMap::new())),
            deribit: Arc::new(RwLock::new(HashMap::new())),
            deribit_greeks: Arc::new(RwLock::new(HashMap::new())),
            derive_tickers: Arc::new(RwLock::new(HashMap::new())),
            derive_spot: Arc::new(RwLock::new(HashMap::new())),
            derive_viewers: Arc::new(RwLock::new(HashMap::new())),
            binance: Arc::new(RwLock::new(HashMap::new())),
            binance_spot: Arc::new(RwLock::new(HashMap::new())),
            futures: Arc::new(RwLock::new(HashMap::new())),
            analysis: Arc::new(RwLock::new(HashMap::new())),
            arbs: Arc::new(RwLock::new(HashMap::new())),
            scanners: Arc::new(RwLock::new(HashMap::new())),
            sse_senders: Arc::new(RwLock::new(HashMap::new())),
            polymarket_prices: Arc::new(RwLock::new(HashMap::new())),
            polymarket_discovery: Arc::new(RwLock::new(HashMap::new())),
            polymarket_oi: Arc::new(RwLock::new(HashMap::new())),
            polymarket_token_asset: Arc::new(RwLock::new(HashMap::new())),
            derive_dirty: {
                let mut m = HashMap::new();
                m.insert("BTC", AtomicBool::new(false));
                m.insert("ETH", AtomicBool::new(false));
                m
            },
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap(),
        }
    }
}
