use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::binance::build_response;
use crate::state::AppState;

const KNOWN_COINS: &[&str] = &["BTC", "ETH", "SOL"];

pub async fn options_chain(
    State(state): State<Arc<AppState>>,
    Path(coin): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = coin.to_uppercase();

    if !KNOWN_COINS.contains(&coin.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown coin: {}", coin) })),
        ));
    }

    let data = {
        let binance = state.binance.read().await;
        let spot = state.binance_spot.read().await;
        build_response(&binance, &spot, &coin)
    };

    match data {
        Some(d) => Ok(Json(d)),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for WS warm-up" })),
        )),
    }
}
