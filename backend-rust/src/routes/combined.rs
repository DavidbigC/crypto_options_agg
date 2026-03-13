use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::exchanges::combined::build_combined_response;
use crate::state::AppState;

const KNOWN_COINS: &[&str] = &["BTC", "ETH", "SOL"];

pub async fn options_chain(
    State(state): State<Arc<AppState>>,
    Path(base_coin): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let coin = base_coin.to_uppercase();

    if !KNOWN_COINS.contains(&coin.as_str()) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("Unknown coin: {}", coin) })),
        ));
    }

    match build_combined_response(&state, &coin).await {
        Some(data) => Ok(Json(data)),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Cache empty — wait for poll warm-up" })),
        )),
    }
}
