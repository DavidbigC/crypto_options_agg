use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::okx::build_response;
use crate::state::AppState;

const KNOWN_FAMILIES: &[&str] = &["BTC-USD", "ETH-USD"];

pub async fn options_chain(
    State(state): State<Arc<AppState>>,
    Path(inst_family): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let family = inst_family.to_uppercase();

    if !KNOWN_FAMILIES.contains(&family.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown instFamily: {}", family) })),
        ));
    }

    let data = {
        let greeks = state.okx_greeks.read().await;
        let ticker = state.okx_ticker.read().await;
        let spot = state.okx_spot.read().await;
        build_response(&greeks, &ticker, &spot, &family)
    };

    if data.is_null() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for poll warm-up" })),
        ));
    }
    Ok(Json(data))
}

pub async fn spots(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let spot_cache = state.okx_spot.read().await;
    Json(json!({
        "BTC-USDT": spot_cache.get("BTC-USDT").copied().unwrap_or(0.0),
        "ETH-USDT": spot_cache.get("ETH-USDT").copied().unwrap_or(0.0),
    }))
}

pub async fn debug(
    State(state): State<Arc<AppState>>,
    Path(inst_family): Path<String>,
) -> Json<Value> {
    let family = inst_family.to_uppercase();
    let greeks = state.okx_greeks.read().await;
    let ticker = state.okx_ticker.read().await;
    let spot = state.okx_spot.read().await;

    let total_greeks = greeks
        .get(&family)
        .map(|m| m.len())
        .unwrap_or(0);
    let total_tickers = ticker
        .get(&family)
        .map(|m| m.len())
        .unwrap_or(0);
    let spot_btc = spot.get("BTC-USDT").copied().unwrap_or(0.0);
    let spot_eth = spot.get("ETH-USDT").copied().unwrap_or(0.0);

    // Sample up to 5 items from greeks
    let sample: Vec<Value> = greeks
        .get(&family)
        .map(|m| {
            m.iter()
                .take(5)
                .map(|(inst_id, item)| {
                    let t = ticker
                        .get(&family)
                        .and_then(|tm| tm.get(inst_id))
                        .cloned()
                        .unwrap_or(json!({}));
                    json!({
                        "instId": inst_id,
                        "greeks": item,
                        "ticker": t,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Json(json!({
        "family": family,
        "totalGreeks": total_greeks,
        "totalTickers": total_tickers,
        "spotBTC": spot_btc,
        "spotETH": spot_eth,
        "sample": sample,
    }))
}
