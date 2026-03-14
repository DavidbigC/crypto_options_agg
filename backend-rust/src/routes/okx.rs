use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::okx::build_response;
use crate::state::AppState;

#[derive(Deserialize, Default)]
pub struct OkxDebugQuery {
    pub strike: Option<String>,
    pub expiry: Option<String>,
}

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
    Query(query): Query<OkxDebugQuery>,
) -> Json<Value> {
    let family = inst_family.to_uppercase();
    let greeks = state.okx_greeks.read().await;

    let cache = match greeks.get(&family) {
        Some(m) => m,
        None => return Json(json!({ "error": "Unknown family" })),
    };

    let keys: Vec<&String> = cache.keys().collect();
    let total_cached = keys.len();

    let mut filtered: Vec<&String> = keys;
    if let Some(ref strike) = query.strike {
        filtered = filtered.into_iter().filter(|k| k.contains(&format!("-{}-", strike))).collect();
    }
    if let Some(ref expiry) = query.expiry {
        filtered = filtered.into_iter().filter(|k| k.contains(&format!("-{}-", expiry))).collect();
    }
    let matched = filtered.len();

    let sample: Vec<Value> = filtered.iter().take(5).map(|inst_id| {
        let item = &cache[*inst_id];
        let mark_vol  = item["markVol"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let bid_vol   = item["bidVol"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let ask_vol   = item["askVol"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let delta     = item["delta"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        json!({
            "instId": inst_id,
            "normalized": {
                "markVol": mark_vol,
                "bidVol":  bid_vol,
                "askVol":  ask_vol,
                "delta":   delta,
            },
            "raw": {
                "markVol": item["markVol"],
                "bidVol":  item["bidVol"],
                "askVol":  item["askVol"],
            },
        })
    }).collect();

    Json(json!({
        "totalCached": total_cached,
        "matched":     matched,
        "sample":      sample,
    }))
}
