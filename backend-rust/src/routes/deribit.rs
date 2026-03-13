use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::deribit::build_response;
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
        let deribit = state.deribit.read().await;
        let greeks = state.deribit_greeks.read().await;
        build_response(&deribit, &greeks, &coin)
    };

    match data {
        Some(d) => Ok(Json(d)),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for poll warm-up" })),
        )),
    }
}
