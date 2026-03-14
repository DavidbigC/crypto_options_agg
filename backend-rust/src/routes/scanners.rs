use crate::{analysis, exchanges, state::AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

const VALID_EXCHANGES: &[&str] = &["bybit", "okx", "deribit", "derive", "binance", "combined"];
const VALID_COINS: &[&str]     = &["BTC", "ETH", "SOL"];
const CACHE_TTL_MS: i64        = 30_000;

#[derive(Deserialize, Default)]
pub struct ScannerQuery {
    /// Comma-separated list of exchanges to use for price resolution, e.g. "bybit,deribit"
    pub exchanges: Option<String>,
}

pub async fn handler(
    Path((exchange, coin)): Path<(String, String)>,
    Query(query): Query<ScannerQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let exchange = exchange.to_lowercase();
    let coin     = coin.to_uppercase();

    if !VALID_EXCHANGES.contains(&exchange.as_str()) { return Err(StatusCode::BAD_REQUEST); }
    if !VALID_COINS.contains(&coin.as_str())         { return Err(StatusCode::BAD_REQUEST); }
    if exchange == "okx" && coin == "SOL"            { return Err(StatusCode::BAD_REQUEST); }

    // Parse ?exchanges= query param
    let active_exchanges_owned: Vec<String> = query.exchanges
        .as_deref()
        .map(|s| s.split(',').map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect())
        .unwrap_or_default();
    let active_exchanges: Vec<&str> = active_exchanges_owned.iter().map(|s| s.as_str()).collect();

    let cache_key = format!("{}:{}:{}", exchange, coin,
        active_exchanges_owned.join(","));

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Check TTL cache
    {
        let cache = state.scanners.read().await;
        if let Some(cached) = cache.get(&cache_key) {
            let updated_at = cached["updatedAt"].as_i64().unwrap_or(0);
            if now_ms - updated_at < CACHE_TTL_MS {
                return Ok(Json(cached.clone()));
            }
        }
    }

    // Build exchange response
    let options_data = match exchange.as_str() {
        "bybit" => {
            let ticker = state.bybit_ticker.read().await;
            let spot   = state.bybit_spot.read().await;
            let r = exchanges::bybit::build_response(&ticker, &spot, &coin);
            drop(ticker); drop(spot); r
        }
        "okx" => {
            let inst_family = format!("{}-USD", coin);
            let greeks = state.okx_greeks.read().await;
            let ticker = state.okx_ticker.read().await;
            let spot   = state.okx_spot.read().await;
            let r = exchanges::okx::build_response(&greeks, &ticker, &spot, &inst_family);
            drop(greeks); drop(ticker); drop(spot); r
        }
        "deribit" => {
            let deribit = state.deribit.read().await;
            let greeks  = state.deribit_greeks.read().await;
            let r = exchanges::deribit::build_response(&deribit, &greeks, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(deribit); drop(greeks); r
        }
        "derive" => {
            let tickers = state.derive_tickers.read().await;
            let spot    = state.derive_spot.read().await;
            let r = exchanges::derive::build_response(&tickers, &spot, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(tickers); drop(spot); r
        }
        "binance" => {
            let cache = state.binance.read().await;
            let spot  = state.binance_spot.read().await;
            let r = exchanges::binance::build_response(&cache, &spot, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(cache); drop(spot); r
        }
        "combined" => {
            exchanges::combined::build_combined_response(&state, &coin).await
                .unwrap_or(serde_json::Value::Null)
        }
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    if options_data.is_null() { return Err(StatusCode::SERVICE_UNAVAILABLE); }

    let spot = options_data["spotPrice"].as_f64().unwrap_or(0.0);
    if spot <= 0.0 { return Err(StatusCode::SERVICE_UNAVAILABLE); }

    let gamma_rows = analysis::scanners::compute_gamma_rows(&options_data, spot, &active_exchanges);
    let vega_rows  = analysis::scanners::compute_vega_rows(&options_data,  spot, &active_exchanges);

    let result = json!({
        "gamma":     gamma_rows,
        "vega":      vega_rows,
        "updatedAt": now_ms,
        "_raw": {
            "optionsData": options_data,
            "spotPrice":   spot,
        },
    });

    state.scanners.write().await.insert(cache_key, result.clone());

    Ok(Json(result))
}
