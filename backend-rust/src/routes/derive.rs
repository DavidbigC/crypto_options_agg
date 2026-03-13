use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::derive::build_response;
use crate::state::AppState;

const KNOWN_COINS: &[&str] = &["BTC", "ETH"];

pub async fn options_chain(
    State(state): State<Arc<AppState>>,
    Path(coin): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = coin.to_uppercase();

    if !KNOWN_COINS.contains(&coin.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown coin: {}. Derive supports: BTC, ETH", coin) })),
        ));
    }

    let data = {
        let tickers = state.derive_tickers.read().await;
        let spot = state.derive_spot.read().await;
        build_response(&tickers, &spot, &coin)
    };

    match data {
        Some(d) => Ok(Json(d)),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for bootstrap warm-up" })),
        )),
    }
}

pub async fn debug(
    State(state): State<Arc<AppState>>,
    Path(coin): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = coin.to_uppercase();

    if !KNOWN_COINS.contains(&coin.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown coin: {}. Derive supports: BTC, ETH", coin) })),
        ));
    }

    let prefix = format!("{}-", coin);

    let (total_cached, spot_price, sample) = {
        let tickers = state.derive_tickers.read().await;
        let spot = state.derive_spot.read().await;

        let total = tickers.keys().filter(|k| k.starts_with(&prefix)).count();
        let spot_val = spot.get(&coin).copied().unwrap_or(0.0);

        let sample: Vec<Value> = tickers
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .take(3)
            .map(|(k, v)| json!({ "instrument": k, "ticker": v }))
            .collect();

        (total, spot_val, sample)
    };

    Ok(Json(json!({
        "totalCached": total_cached,
        "spotCache": spot_price,
        "sample": sample,
    })))
}
