use crate::{analysis, exchanges, state::AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use serde_json::json;
use std::sync::Arc;

const VALID_COINS: &[&str] = &["BTC", "ETH", "SOL"];
const CACHE_TTL_MS: i64 = 30_000;

pub async fn handler(
    Path(coin): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let coin = coin.to_uppercase();
    if !VALID_COINS.contains(&coin.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Check TTL cache
    {
        let cache = state.arbs.read().await;
        if let Some(cached) = cache.get(&coin) {
            let updated_at = cached["updatedAt"].as_i64().unwrap_or(0);
            if now_ms - updated_at < CACHE_TTL_MS {
                return Ok(Json(cached.clone()));
            }
        }
    }

    // Build combined response (arbs need bestBid/bestAsk from combined)
    let combined = exchanges::combined::build_combined_response(&state, &coin)
        .await
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    let spot = combined["spotPrice"].as_f64().unwrap_or(0.0);
    if spot <= 0.0 {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    // Get futures for PCP hedging
    let futures_list = {
        let futures_cache = state.futures.read().await;
        futures_cache.get(&coin).cloned().unwrap_or_default()
    };

    let box_spreads = analysis::arbs::find_box_spreads(&combined, spot, 0.0);
    let all_arbs = analysis::arbs::find_all_arbs(&combined, spot, &futures_list);

    let result = json!({
        "coin":       coin,
        "boxSpreads": box_spreads,
        "allArbs":    all_arbs,
        "updatedAt":  now_ms,
    });

    state.arbs.write().await.insert(coin, result.clone());

    Ok(Json(result))
}
