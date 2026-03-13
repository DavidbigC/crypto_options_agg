use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Json, sse::{Event, Sse}},
};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use crate::state::AppState;

const VALID_ASSETS:   &[&str] = &["BTC", "ETH", "SOL"];
const VALID_HORIZONS: &[&str] = &["daily", "weekly", "monthly", "yearly"];

#[derive(Deserialize, Default)]
pub struct SpotQuery {
    #[serde(rename = "spotPrice")]
    pub spot_price: Option<f64>,
}

pub async fn analysis(
    Path((asset, horizon)): Path<(String, String)>,
    Query(q): Query<SpotQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, StatusCode> {
    let asset   = asset.to_uppercase();
    let horizon = horizon.to_lowercase();
    if !VALID_ASSETS.contains(&asset.as_str())     { return Err(StatusCode::BAD_REQUEST); }
    if !VALID_HORIZONS.contains(&horizon.as_str()) { return Err(StatusCode::BAD_REQUEST); }

    let spot = q.spot_price.unwrap_or(0.0);
    match crate::exchanges::polymarket::get_analysis(
        &asset, &horizon, spot, &state.http_client,
        &state.polymarket_prices, &state.polymarket_discovery, &state.polymarket_oi,
    ).await {
        Ok(v)  => Ok(Json(v)),
        Err(e) => {
            tracing::warn!("Polymarket analysis error: {}", e);
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

pub async fn surface(
    Path(asset): Path<String>,
    Query(q): Query<SpotQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, StatusCode> {
    let asset = asset.to_uppercase();
    if !VALID_ASSETS.contains(&asset.as_str()) { return Err(StatusCode::BAD_REQUEST); }

    let spot = q.spot_price.unwrap_or(0.0);
    match crate::exchanges::polymarket::get_surface(
        &asset, spot, &state.http_client,
        &state.polymarket_prices, &state.polymarket_discovery, &state.polymarket_oi,
    ).await {
        Ok(v)  => Ok(Json(v)),
        Err(e) => {
            tracing::warn!("Polymarket surface error: {}", e);
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

pub async fn stream(
    Path(asset): Path<String>,
    Query(q): Query<SpotQuery>,
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let asset_upper = asset.to_uppercase();
    let spot = q.spot_price.unwrap_or(0.0);

    let key = format!("polymarket:{}", asset_upper);
    let tx = crate::sse::get_or_create_sender(&state.sse_senders, &key).await;
    let mut rx = tx.subscribe();

    let http_client = state.http_client.clone();
    let prices      = state.polymarket_prices.clone();
    let discovery   = state.polymarket_discovery.clone();
    let oi_cache    = state.polymarket_oi.clone();

    let stream = async_stream::stream! {
        yield Ok(Event::default().retry(Duration::from_secs(1)));

        match crate::exchanges::polymarket::get_surface(&asset_upper, spot, &http_client, &prices, &discovery, &oi_cache).await {
            Ok(surface) => {
                if let Ok(payload) = serde_json::to_string(&surface) {
                    yield Ok(Event::default().data(payload));
                }
            }
            Err(e) => tracing::warn!("Polymarket initial surface error: {}", e),
        }

        let lease_end = tokio::time::Instant::now() + Duration::from_secs(crate::sse::LEASE_SECS);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(crate::sse::HEARTBEAT_SECS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if tokio::time::Instant::now() >= lease_end { break; }
                    yield Ok(Event::default().comment("ping"));
                }
                result = rx.recv() => {
                    match result {
                        Ok(payload) => yield Ok(Event::default().data(payload)),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("Polymarket SSE lagged {} messages", n);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
    };

    Sse::new(stream)
}
