use crate::{sse, state::AppState};
use axum::{
    extract::{Path, Query, State},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};

#[derive(Deserialize)]
pub struct StreamQuery {
    pub expiry: Option<String>,
}

pub async fn handler(
    State(state): State<Arc<AppState>>,
    Path((exchange, coin)): Path<(String, String)>,
    Query(query): Query<StreamQuery>,
) -> Response {
    let exchange = exchange.to_lowercase();
    let key = format!("{}:{}", exchange, coin);
    let tx = sse::get_or_create_sender(&state.sse_senders, &key).await;
    let mut rx = tx.subscribe();
    let expiry_filter = query.expiry.clone();
    let snapshot = build_snapshot(&state, &exchange, &coin).await;

    let stream = async_stream::stream! {
        // Initial retry hint
        yield Ok::<Event, std::convert::Infallible>(Event::default().retry(Duration::from_secs(1)));

        if let Some(snapshot) = snapshot {
            let data = match &expiry_filter {
                Some(exp) => filter_by_expiry_value(snapshot, exp),
                None => snapshot.to_string(),
            };
            yield Ok(Event::default().data(data));
        }

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

    let mut response = Sse::new(stream).into_response();
    response.headers_mut().insert(
        "x-accel-buffering",
        axum::http::HeaderValue::from_static("no"),
    );
    response
}

async fn build_snapshot(
    state: &Arc<AppState>,
    exchange: &str,
    coin: &str,
) -> Option<serde_json::Value> {
    match exchange {
        "bybit" => {
            let ticker = state.bybit_ticker.read().await;
            let spot = state.bybit_spot.read().await;
            let payload =
                crate::exchanges::bybit::build_response(&ticker, &spot, &coin.to_uppercase());
            (!payload.is_null()).then_some(payload)
        }
        "okx" => {
            let greeks = state.okx_greeks.read().await;
            let ticker = state.okx_ticker.read().await;
            let spot = state.okx_spot.read().await;
            let payload = crate::exchanges::okx::build_response(
                &greeks,
                &ticker,
                &spot,
                &coin.to_uppercase(),
            );
            (!payload.is_null()).then_some(payload)
        }
        "deribit" => {
            let deribit = state.deribit.read().await;
            let greeks = state.deribit_greeks.read().await;
            crate::exchanges::deribit::build_response(&deribit, &greeks, &coin.to_uppercase())
        }
        "derive" => {
            let tickers = state.derive_tickers.read().await;
            let spot = state.derive_spot.read().await;
            crate::exchanges::derive::build_response(&tickers, &spot, &coin.to_uppercase())
        }
        "binance" => {
            let cache = state.binance.read().await;
            let spot = state.binance_spot.read().await;
            crate::exchanges::binance::build_response(&cache, &spot, &coin.to_uppercase())
        }
        "combined" => {
            crate::exchanges::combined::build_combined_response(state, &coin.to_uppercase()).await
        }
        _ => None,
    }
}

/// Filter the tickers/data array in a JSON payload to only those matching
/// the given expiry date segment.
fn filter_by_expiry(payload: &str, expiry: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return payload.to_string();
    };
    filter_by_expiry_in_place(&mut v, expiry);
    serde_json::to_string(&v).unwrap_or_else(|_| payload.to_string())
}

fn filter_by_expiry_value(mut payload: serde_json::Value, expiry: &str) -> String {
    filter_by_expiry_in_place(&mut payload, expiry);
    serde_json::to_string(&payload).unwrap_or_else(|_| String::new())
}

fn filter_by_expiry_in_place(v: &mut serde_json::Value, expiry: &str) {
    // expiry format: "2025-03-28" -> compact "20250328" for matching against symbols/instIds
    let exp_compact = expiry.replace('-', "");

    // Try multiple locations where tickers might be:
    // Bybit/Binance: root "tickers" array with items having "symbol" field
    // OKX: root "tickers" array with items having "instId" field
    // Deribit/Derive: "data" object keyed by expiry date

    if let Some(arr) = v.get_mut("tickers").and_then(|t| t.as_array_mut()) {
        arr.retain(|item| {
            item["symbol"]
                .as_str()
                .or_else(|| item["instId"].as_str())
                .map(|s| s.contains(&exp_compact))
                .unwrap_or(false)
        });
        return;
    }

    // For structured responses (Bybit/OKX full buildResponse format), mimic the Node backend:
    // keep full metadata, but replace "data" with a single expiry entry.
    if let Some(data_value) = v.get("data") {
        let chain = data_value
            .get(expiry)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "calls": [], "puts": [] }));
        v["data"] = serde_json::json!({ expiry: chain });
    }
}

#[cfg(test)]
mod tests {
    use super::filter_by_expiry;
    use serde_json::json;

    #[test]
    fn filter_by_expiry_keeps_metadata_and_only_narrows_data() {
        let payload = json!({
            "spotPrice": 100000.0,
            "expirations": ["2026-03-20", "2026-03-27"],
            "expirationCounts": {
                "2026-03-20": { "calls": 1, "puts": 1 },
                "2026-03-27": { "calls": 2, "puts": 2 }
            },
            "data": {
                "2026-03-20": { "calls": [{"strike": 100000}], "puts": [{"strike": 100000}], "forwardPrice": 100500.0 },
                "2026-03-27": { "calls": [{"strike": 110000}], "puts": [{"strike": 90000}], "forwardPrice": 101000.0 }
            }
        });

        let filtered: serde_json::Value =
            serde_json::from_str(&filter_by_expiry(&payload.to_string(), "2026-03-20")).unwrap();

        assert_eq!(filtered["expirations"], payload["expirations"]);
        assert_eq!(filtered["expirationCounts"], payload["expirationCounts"]);
        assert_eq!(
            filtered["data"]["2026-03-20"],
            payload["data"]["2026-03-20"]
        );
        assert!(filtered["data"].get("2026-03-27").is_none());
    }
}
