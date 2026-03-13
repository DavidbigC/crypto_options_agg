use crate::state::AppState;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const WS_URL: &str = "wss://fstream.binance.com/market/stream?streams=btcusdt@optionMarkPrice/ethusdt@optionMarkPrice/solusdt@optionMarkPrice";

pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut backoff = 2u64;
        loop {
            match run_ws(&state).await {
                Ok(_) => {
                    tracing::info!("Binance WS closed cleanly, reconnecting in 2s");
                    sleep(Duration::from_secs(2)).await;
                    backoff = 2;
                }
                Err(e) => {
                    tracing::warn!("Binance WS error: {}, reconnecting in {}s", e, backoff);
                    sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    });

    tracing::info!("Binance WS started");
}

async fn run_ws(state: &AppState) -> Result<()> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    tracing::info!("Binance WS connected");

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(tokio::sync::Mutex::new(write));

    // Heartbeat: ping every 3 minutes
    let write_hb = write.clone();
    let hb_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(180)).await;
            let mut w = write_hb.lock().await;
            if w.send(Message::Ping(vec![])).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg_result) = read.next().await {
        let msg = msg_result?;
        match msg {
            Message::Text(text) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    handle_message(state, &parsed).await;
                }
            }
            Message::Ping(data) => {
                let mut w = write.lock().await;
                let _ = w.send(Message::Pong(data)).await;
            }
            Message::Close(_) => {
                tracing::info!("Binance WS received close frame");
                break;
            }
            _ => {}
        }
    }

    hb_handle.abort();
    Ok(())
}

async fn handle_message(state: &AppState, msg: &Value) {
    let stream = match msg["stream"].as_str() {
        Some(s) => s,
        None => return,
    };

    let coin = if stream.starts_with("btc") {
        "BTC"
    } else if stream.starts_with("eth") {
        "ETH"
    } else if stream.starts_with("sol") {
        "SOL"
    } else {
        return;
    };

    let items = match msg["data"].as_array() {
        Some(arr) => arr.clone(),
        None => return,
    };

    {
        let mut cache = state.binance.write().await;
        let mut spot_cache = state.binance_spot.write().await;
        let coin_cache = cache.entry(coin.to_string()).or_default();

        for item in &items {
            let symbol = match item["s"].as_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            if let Some(index_price) = item["i"].as_f64() {
                if index_price > 0.0 {
                    spot_cache.insert(coin.to_string(), index_price);
                }
            }
            coin_cache.insert(symbol, item.clone());
        }
    }

    let payload = {
        let binance = state.binance.read().await;
        let spot = state.binance_spot.read().await;
        build_response(&binance, &spot, coin)
    };

    if let Some(p) = payload {
        let key = format!("binance:{}", coin);
        crate::sse::broadcast(&state.sse_senders, &key, p.to_string()).await;
    }
}

fn parse_symbol(symbol: &str) -> Option<(String, f64, &'static str)> {
    // Format: BTC-250328-80000-C
    let parts: Vec<&str> = symbol.split('-').collect();
    if parts.len() < 4 {
        return None;
    }
    let date_part = parts[1]; // YYMMDD
    if date_part.len() < 6 {
        return None;
    }
    let expiry = format!(
        "20{}-{}-{}",
        &date_part[0..2],
        &date_part[2..4],
        &date_part[4..6]
    );
    let strike: f64 = parts[2].parse().ok()?;
    let option_type: &'static str = if parts[3] == "C" { "call" } else { "put" };
    Some((expiry, strike, option_type))
}

pub fn build_response(
    binance: &crate::cache::BinanceCache,
    spot_cache: &crate::cache::BinanceSpotCache,
    coin: &str,
) -> Option<Value> {
    let coin_cache = binance.get(coin)?;
    if coin_cache.is_empty() {
        return None;
    }

    let spot_price = spot_cache.get(coin).copied().unwrap_or(0.0);

    let mut options_by_date: HashMap<String, (Vec<Value>, Vec<Value>, f64)> = HashMap::new();

    for (symbol, item) in coin_cache {
        let (expiry, strike, option_type) = match parse_symbol(symbol) {
            Some(p) => p,
            None => continue,
        };

        let contract = json!({
            "symbol":            symbol,
            "strike":            strike,
            "optionType":        option_type,
            "bid":               item["bo"].as_f64().unwrap_or(0.0),
            "ask":               item["ao"].as_f64().unwrap_or(0.0),
            "last":              0,
            "volume":            0,
            "bidSize":           item["bq"].as_f64().unwrap_or(0.0),
            "askSize":           item["aq"].as_f64().unwrap_or(0.0),
            "delta":             item["d"].as_f64().unwrap_or(0.0),
            "gamma":             item["g"].as_f64().unwrap_or(0.0),
            "theta":             item["t"].as_f64().unwrap_or(0.0),
            "vega":              item["v"].as_f64().unwrap_or(0.0),
            "impliedVolatility": item["vo"].as_f64().unwrap_or(0.0),
            "markVol":           item["vo"].as_f64().unwrap_or(0.0),
            "bidVol":            item["b"].as_f64().unwrap_or(0.0),
            "askVol":            item["a"].as_f64().unwrap_or(0.0),
            "markPrice":         item["mp"].as_f64().unwrap_or(0.0),
            "openInterest":      0,
        });

        let entry = options_by_date
            .entry(expiry)
            .or_insert_with(|| (vec![], vec![], spot_price));

        if option_type == "call" {
            entry.0.push(contract);
        } else {
            entry.1.push(contract);
        }
    }

    if options_by_date.is_empty() {
        return None;
    }

    let mut sorted_dates: Vec<String> = options_by_date.keys().cloned().collect();
    sorted_dates.sort();

    let mut expiration_counts = serde_json::Map::new();
    let mut data_obj = serde_json::Map::new();

    for date in &sorted_dates {
        let (calls, puts, fwd) = &options_by_date[date];
        expiration_counts.insert(
            date.clone(),
            json!({ "calls": calls.len(), "puts": puts.len() }),
        );
        data_obj.insert(
            date.clone(),
            json!({
                "calls": calls,
                "puts": puts,
                "forwardPrice": fwd,
            }),
        );
    }

    Some(json!({
        "spotPrice": spot_price,
        "expirations": sorted_dates,
        "expirationCounts": expiration_counts,
        "data": data_obj,
    }))
}
