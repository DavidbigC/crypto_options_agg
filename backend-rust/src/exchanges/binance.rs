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
            let index_price = parse_f64_value(&item["i"]);
            if index_price > 0.0 {
                spot_cache.insert(coin.to_string(), index_price);
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
        crate::exchanges::combined::broadcast_update(state, coin).await;
    }
}

fn parse_f64_value(value: &Value) -> f64 {
    match value {
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn has_contract_signal(
    bid: f64,
    ask: f64,
    bid_size: f64,
    ask_size: f64,
    delta: f64,
    gamma: f64,
    theta: f64,
    vega: f64,
    mark_vol: f64,
    bid_vol: f64,
    ask_vol: f64,
    mark_price: f64,
) -> bool {
    bid > 0.0
        || ask > 0.0
        || bid_size > 0.0
        || ask_size > 0.0
        || delta != 0.0
        || gamma != 0.0
        || theta != 0.0
        || vega != 0.0
        || mark_vol > 0.0
        || bid_vol > 0.0
        || ask_vol > 0.0
        || mark_price > 0.0
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

        let bid = parse_f64_value(&item["bo"]);
        let ask = parse_f64_value(&item["ao"]);
        let bid_size = parse_f64_value(&item["bq"]);
        let ask_size = parse_f64_value(&item["aq"]);
        let delta = parse_f64_value(&item["d"]);
        let gamma = parse_f64_value(&item["g"]);
        let theta = parse_f64_value(&item["t"]);
        let vega = parse_f64_value(&item["v"]);
        let implied_volatility = parse_f64_value(&item["vo"]);
        let bid_vol = parse_f64_value(&item["b"]);
        let ask_vol = parse_f64_value(&item["a"]);
        let mark_price = parse_f64_value(&item["mp"]);

        if !has_contract_signal(
            bid,
            ask,
            bid_size,
            ask_size,
            delta,
            gamma,
            theta,
            vega,
            implied_volatility,
            bid_vol,
            ask_vol,
            mark_price,
        ) {
            continue;
        }

        let contract = json!({
            "symbol":            symbol,
            "strike":            strike,
            "optionType":        option_type,
            "bid":               bid,
            "ask":               ask,
            "last":              0,
            "volume":            0,
            "bidSize":           bid_size,
            "askSize":           ask_size,
            "delta":             delta,
            "gamma":             gamma,
            "theta":             theta,
            "vega":              vega,
            "impliedVolatility": implied_volatility,
            "markVol":           implied_volatility,
            "bidVol":            bid_vol,
            "askVol":            ask_vol,
            "markPrice":         mark_price,
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

#[cfg(test)]
mod tests {
    use super::{build_response, handle_message};
    use crate::{sse, state::AppState};
    use serde_json::json;
    use std::{collections::HashMap, sync::Arc, time::Duration};

    #[tokio::test]
    async fn binance_updates_refresh_the_combined_btc_stream() {
        let state = Arc::new(AppState::new());
        let tx = sse::get_or_create_sender(&state.sse_senders, "combined:BTC").await;
        let mut rx = tx.subscribe();

        handle_message(
            &state,
            &json!({
                "stream": "btcusdt@optionMarkPrice",
                "data": [{
                    "s": "BTC-260320-100000-C",
                    "i": "100500",
                    "bo": "12.5",
                    "ao": "13.0",
                    "bq": "1",
                    "aq": "1",
                    "d": "0.5",
                    "g": "0.01",
                    "t": "-5",
                    "v": "100",
                    "vo": "0.6",
                    "b": "0.58",
                    "a": "0.62",
                    "mp": "12.7"
                }]
            }),
        )
        .await;

        let payload = tokio::time::timeout(Duration::from_millis(100), rx.recv())
            .await
            .expect("expected combined stream update")
            .expect("combined stream channel should stay open");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("combined stream payload should be valid json");

        assert_eq!(parsed["spotPrice"], json!(100500.0));
        assert_eq!(parsed["expirations"], json!(["2026-03-20"]));
        assert_eq!(
            parsed["data"]["2026-03-20"]["calls"][0]["strike"],
            json!(100000.0)
        );
        assert_eq!(
            parsed["data"]["2026-03-20"]["calls"][0]["bestBidEx"],
            json!("binance")
        );
    }

    #[test]
    fn build_response_parses_string_encoded_binance_fields() {
        let mut by_coin = HashMap::new();
        by_coin.insert(
            "BTC".to_string(),
            [(
                "BTC-260314-70000-C".to_string(),
                json!({
                    "bo": "12.5",
                    "ao": "13.5",
                    "bq": "1.1",
                    "aq": "2.2",
                    "d": "0.48",
                    "g": "0.0003",
                    "t": "-9.5",
                    "v": "31.2",
                    "vo": "0.57",
                    "b": "0.55",
                    "a": "0.59",
                    "mp": "13.0"
                }),
            )]
            .into_iter()
            .collect(),
        );

        let mut spot = HashMap::new();
        spot.insert("BTC".to_string(), 70123.4);

        let response = build_response(&by_coin, &spot, "BTC").expect("binance response");
        let contract = &response["data"]["2026-03-14"]["calls"][0];

        assert_eq!(response["spotPrice"], json!(70123.4));
        assert_eq!(contract["bid"], json!(12.5));
        assert_eq!(contract["ask"], json!(13.5));
        assert_eq!(contract["bidSize"], json!(1.1));
        assert_eq!(contract["askSize"], json!(2.2));
        assert_eq!(contract["delta"], json!(0.48));
        assert_eq!(contract["gamma"], json!(0.0003));
        assert_eq!(contract["theta"], json!(-9.5));
        assert_eq!(contract["vega"], json!(31.2));
        assert_eq!(contract["markVol"], json!(0.57));
        assert_eq!(contract["bidVol"], json!(0.55));
        assert_eq!(contract["askVol"], json!(0.59));
        assert_eq!(contract["markPrice"], json!(13.0));
    }
}
