use crate::cache::*;
use crate::sse::SseSenders;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Default)]
pub struct AppState {
    pub bybit_ticker:    Arc<RwLock<BybitTickerCache>>,
    pub bybit_spot:      Arc<RwLock<BybitSpotCache>>,

    pub okx_greeks:      Arc<RwLock<OkxGreeksCache>>,
    pub okx_ticker:      Arc<RwLock<OkxTickerCache>>,
    pub okx_spot:        Arc<RwLock<OkxSpotCache>>,

    pub deribit:         Arc<RwLock<DeribitCache>>,
    pub deribit_greeks:  Arc<RwLock<DeribitGreeksCache>>,

    pub derive_tickers:  Arc<RwLock<DeriveTickersCache>>,
    pub derive_spot:     Arc<RwLock<DeriveSpotCache>>,
    pub derive_viewers:  Arc<RwLock<DeriveViewerCount>>,

    pub binance:         Arc<RwLock<BinanceCache>>,
    pub binance_spot:    Arc<RwLock<BinanceSpotCache>>,

    pub futures:         Arc<RwLock<FuturesCache>>,

    pub analysis:        Arc<RwLock<AnalysisCache>>,
    pub arbs:            Arc<RwLock<ArbCache>>,
    pub scanners:        Arc<RwLock<ScannerCache>>,

    // SSE broadcast channels: key = "exchange:coin" (e.g., "bybit:BTC")
    pub sse_senders: SseSenders,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
