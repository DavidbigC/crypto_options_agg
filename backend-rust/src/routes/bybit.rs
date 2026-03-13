use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::bybit::{build_response, time_to_expiration_days};
use crate::state::AppState;

pub async fn options_chain(
    State(state): State<Arc<AppState>>,
    Path(base_coin): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = base_coin.to_uppercase();
    let ticker_cache = state.bybit_ticker.read().await;
    let spot_cache = state.bybit_spot.read().await;
    let data = build_response(&ticker_cache, &spot_cache, &coin);
    if data.is_null() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for poll warm-up" })),
        ));
    }
    Ok(Json(data))
}

pub async fn options_chain_expiry(
    State(state): State<Arc<AppState>>,
    Path((base_coin, expiration)): Path<(String, String)>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = base_coin.to_uppercase();
    let ticker_cache = state.bybit_ticker.read().await;
    let spot_cache = state.bybit_spot.read().await;
    let full_data = build_response(&ticker_cache, &spot_cache, &coin);
    drop(ticker_cache);
    drop(spot_cache);

    if full_data.is_null() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for poll warm-up" })),
        ));
    }

    let chain_data = match full_data["data"].get(&expiration) {
        Some(d) => d.clone(),
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("No data found for {} expiration {}", coin, expiration) })),
            ));
        }
    };

    let spot_price = full_data["spotPrice"].as_f64().unwrap_or(0.0);

    // Collect all strikes
    let mut strikes_set = std::collections::BTreeSet::new();
    if let Some(calls) = chain_data["calls"].as_array() {
        for c in calls {
            if let Some(s) = c["strike"].as_f64() {
                strikes_set.insert(ordered_float(s));
            }
        }
    }
    if let Some(puts) = chain_data["puts"].as_array() {
        for p in puts {
            if let Some(s) = p["strike"].as_f64() {
                strikes_set.insert(ordered_float(s));
            }
        }
    }
    let strikes: Vec<f64> = strikes_set.iter().map(|&bits| f64::from_bits(bits)).collect();

    // ATM strike: closest to spot
    let atm_strike = strikes
        .iter()
        .copied()
        .min_by(|a, b| {
            let da = (a - spot_price).abs();
            let db = (b - spot_price).abs();
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0.0);

    let time_to_expiration = time_to_expiration_days(&expiration);

    let total_calls = chain_data["calls"].as_array().map(|a| a.len()).unwrap_or(0);
    let total_puts = chain_data["puts"].as_array().map(|a| a.len()).unwrap_or(0);

    // Group by strike: { "45000": { "call": ..., "put": ... } }
    let mut options_map = serde_json::Map::new();
    if let Some(calls) = chain_data["calls"].as_array() {
        for c in calls {
            if let Some(s) = c["strike"].as_f64() {
                let key = format!("{}", s as i64);
                let entry = options_map.entry(key).or_insert_with(|| json!({}));
                entry["call"] = c.clone();
            }
        }
    }
    if let Some(puts) = chain_data["puts"].as_array() {
        for p in puts {
            if let Some(s) = p["strike"].as_f64() {
                let key = format!("{}", s as i64);
                let entry = options_map.entry(key).or_insert_with(|| json!({}));
                entry["put"] = p.clone();
            }
        }
    }

    Ok(Json(json!({
        "expiration": expiration,
        "spotPrice": spot_price,
        "atmStrike": atm_strike,
        "timeToExpiration": time_to_expiration,
        "totalCalls": total_calls,
        "totalPuts": total_puts,
        "strikes": strikes,
        "options": options_map,
        "rawData": chain_data,
    })))
}

pub async fn spots(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let spot_cache = state.bybit_spot.read().await;
    Json(json!({
        "BTCUSDT": spot_cache.get("BTC").copied().unwrap_or(0.0),
        "ETHUSDT": spot_cache.get("ETH").copied().unwrap_or(0.0),
        "SOLUSDT": spot_cache.get("SOL").copied().unwrap_or(0.0),
    }))
}

pub async fn spot_single(
    State(state): State<Arc<AppState>>,
    Path(symbol): Path<String>,
) -> Json<Value> {
    let spot_cache = state.bybit_spot.read().await;
    // symbol is like "BTCUSDT" — map to coin key
    let coin = symbol_to_coin(&symbol);
    let price = coin
        .and_then(|c| spot_cache.get(c).copied())
        .unwrap_or(0.0);
    Json(json!({ "symbol": symbol, "price": price }))
}

fn symbol_to_coin(symbol: &str) -> Option<&'static str> {
    match symbol.to_uppercase().as_str() {
        "BTCUSDT" => Some("BTC"),
        "ETHUSDT" => Some("ETH"),
        "SOLUSDT" => Some("SOL"),
        _ => None,
    }
}

// BTreeSet requires Ord; use bit representation for f64 ordering (values are positive strikes)
fn ordered_float(f: f64) -> u64 {
    f.to_bits()
}
