use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use serde_json::json;
use std::sync::Arc;

const VALID_COINS: &[&str] = &["BTC", "ETH", "SOL"];

pub async fn futures_chain(
    Path(coin): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let coin = coin.to_uppercase();
    if !VALID_COINS.contains(&coin.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cache = state.futures.read().await;
    let rows = cache.get(&coin).cloned().unwrap_or_default();
    if rows.is_empty() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    Ok(Json(json!({ "coin": coin, "futures": rows })))
}
