use crate::{analysis, exchanges, state::AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use std::sync::Arc;

const VALID_EXCHANGES: &[&str] = &["bybit", "okx", "deribit", "derive", "binance", "combined"];
const VALID_COINS: &[&str] = &["BTC", "ETH", "SOL"];
/// Cache TTL: recompute if older than 30s
const CACHE_TTL_MS: i64 = 30_000;

pub async fn handler(
    Path((exchange, coin)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let exchange = exchange.to_lowercase();
    let coin = coin.to_uppercase();

    if !VALID_EXCHANGES.contains(&exchange.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !VALID_COINS.contains(&coin.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    // OKX uses instFamily format; SOL is not supported on OKX
    if exchange == "okx" && coin == "SOL" {
        return Err(StatusCode::BAD_REQUEST);
    }

    let cache_key = format!("{}:{}", exchange, coin);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Check TTL cache
    {
        let cache = state.analysis.read().await;
        if let Some(cached) = cache.get(&cache_key) {
            let updated_at = cached["updatedAt"].as_i64().unwrap_or(0);
            if now_ms - updated_at < CACHE_TTL_MS {
                return Ok(Json(cached.clone()));
            }
        }
    }

    // Build exchange response (acquire read locks, call build_response, release immediately)
    let exchange_response = match exchange.as_str() {
        "bybit" => {
            let ticker = state.bybit_ticker.read().await;
            let spot = state.bybit_spot.read().await;
            let resp = exchanges::bybit::build_response(&ticker, &spot, &coin);
            drop(ticker);
            drop(spot);
            resp
        }
        "okx" => {
            let inst_family = format!("{}-USD", coin);
            let greeks = state.okx_greeks.read().await;
            let ticker = state.okx_ticker.read().await;
            let spot = state.okx_spot.read().await;
            let resp = exchanges::okx::build_response(&greeks, &ticker, &spot, &inst_family);
            drop(greeks);
            drop(ticker);
            drop(spot);
            resp
        }
        "deribit" => {
            let deribit = state.deribit.read().await;
            let greeks = state.deribit_greeks.read().await;
            let resp = exchanges::deribit::build_response(&deribit, &greeks, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(deribit);
            drop(greeks);
            resp
        }
        "derive" => {
            let tickers = state.derive_tickers.read().await;
            let spot = state.derive_spot.read().await;
            let resp = exchanges::derive::build_response(&tickers, &spot, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(tickers);
            drop(spot);
            resp
        }
        "binance" => {
            let cache = state.binance.read().await;
            let spot = state.binance_spot.read().await;
            let resp = exchanges::binance::build_response(&cache, &spot, &coin)
                .unwrap_or(serde_json::Value::Null);
            drop(cache);
            drop(spot);
            resp
        }
        "combined" => exchanges::combined::build_combined_response(&state, &coin)
            .await
            .unwrap_or(serde_json::Value::Null),
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    if exchange_response.is_null() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    let spot = exchange_response["spotPrice"].as_f64().unwrap_or(0.0);
    let result = analysis::compute_analysis(&exchange_response, spot)
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    state
        .analysis
        .write()
        .await
        .insert(cache_key, result.clone());

    Ok(Json(result))
}
