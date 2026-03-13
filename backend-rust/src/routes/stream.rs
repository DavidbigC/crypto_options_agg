use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, Sse},
};
use std::{sync::Arc, time::Duration};
use futures_util::stream::Stream;
use serde::Deserialize;
use crate::{state::AppState, sse};

#[derive(Deserialize)]
pub struct StreamQuery {
    pub expiry: Option<String>,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Path((exchange, coin)): Path<(String, String)>,
    Query(query): Query<StreamQuery>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let key = format!("{}:{}", exchange.to_lowercase(), coin);
    let tx = sse::get_or_create_sender(&state.sse_senders, &key).await;
    let mut rx = tx.subscribe();
    let expiry_filter = query.expiry.clone();

    let stream = async_stream::stream! {
        // Initial retry hint
        yield Ok(Event::default().retry(Duration::from_secs(1)));

        let lease_end = tokio::time::Instant::now() + Duration::from_secs(sse::LEASE_SECS);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(sse::HEARTBEAT_SECS));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if tokio::time::Instant::now() >= lease_end {
                        break; // Lease expired
                    }
                    yield Ok(Event::default().comment("ping"));
                }
                result = rx.recv() => {
                    match result {
                        Ok(payload) => {
                            let data = match &expiry_filter {
                                Some(exp) => filter_by_expiry(&payload, exp),
                                None => payload,
                            };
                            yield Ok(Event::default().data(data));
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("SSE client lagged by {} messages on {}", n, key);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
            }
        }
    };

    Sse::new(stream)
}

/// Filter the tickers/data array in a JSON payload to only those matching
/// the given expiry date segment.
fn filter_by_expiry(payload: &str, expiry: &str) -> String {
    // expiry format: "2025-03-28" -> compact "20250328" for matching against symbols/instIds
    let exp_compact = expiry.replace('-', "");

    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return payload.to_string();
    };

    // Try multiple locations where tickers might be:
    // Bybit/Binance: root "tickers" array with items having "symbol" field
    // OKX: root "tickers" array with items having "instId" field
    // Deribit/Derive: "data" object keyed by expiry date

    if let Some(arr) = v.get_mut("tickers").and_then(|t| t.as_array_mut()) {
        arr.retain(|item| {
            item["symbol"].as_str()
                .or_else(|| item["instId"].as_str())
                .map(|s| s.contains(&exp_compact))
                .unwrap_or(false)
        });
        return serde_json::to_string(&v).unwrap_or_else(|_| payload.to_string());
    }

    // For structured responses (Bybit/OKX full buildResponse format):
    // "data" is a map keyed by expiry date "YYYY-MM-DD"
    if let Some(data_obj) = v.get_mut("data").and_then(|d| d.as_object_mut()) {
        data_obj.retain(|key, _| key == expiry);
        // Also update expirations array
        if let Some(exps) = v.get_mut("expirations").and_then(|e| e.as_array_mut()) {
            exps.retain(|e| e.as_str() == Some(expiry));
        }
        return serde_json::to_string(&v).unwrap_or_else(|_| payload.to_string());
    }

    payload.to_string()
}
