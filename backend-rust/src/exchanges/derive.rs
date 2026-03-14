use crate::state::AppState;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const WS_URL: &str = "wss://api.lyra.finance/ws";
const DERIVE_REST: &str = "https://api.lyra.finance";
const CHUNK: usize = 200;
const FAST_EXPIRIES: usize = 4;

const SUPPORTED_CURRENCIES: &[&str] = &["BTC", "ETH"];

pub fn start(state: Arc<AppState>, client: reqwest::Client) {
    let flush_state = state.clone();
    tokio::spawn(async move {
        let mut backoff = 2u64;
        // instruments_cache survives reconnects
        let mut instruments_cache: HashMap<String, Vec<String>> = HashMap::new();

        loop {
            match run_ws(&state, &client, &mut instruments_cache).await {
                Ok(_) => {
                    tracing::info!("Derive WS closed cleanly, reconnecting in 2s");
                    sleep(Duration::from_secs(2)).await;
                    backoff = 2;
                }
                Err(e) => {
                    tracing::warn!("Derive WS error: {}, reconnecting in {}s", e, backoff);
                    sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    });

    // Throttled broadcast flush: every 200ms, broadcast if dirty
    {
        let state = flush_state;
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(200));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                for currency in SUPPORTED_CURRENCIES {
                    if let Some(flag) = state.derive_dirty.get(currency) {
                        if flag.swap(false, std::sync::atomic::Ordering::Relaxed) {
                            let payload = {
                                let tickers = state.derive_tickers.read().await;
                                let spot = state.derive_spot.read().await;
                                build_response(&tickers, &spot, currency)
                            };
                            if let Some(p) = payload {
                                let key = format!("derive:{}", currency);
                                crate::sse::broadcast(&state.sse_senders, &key, p.to_string())
                                    .await;
                                crate::exchanges::combined::broadcast_update(&state, currency)
                                    .await;
                            }
                        }
                    }
                }
            }
        });
    }

    tracing::info!("Derive WS started (broadcast throttled to 200ms)");
}

async fn run_ws(
    state: &AppState,
    client: &reqwest::Client,
    instruments_cache: &mut HashMap<String, Vec<String>>,
) -> Result<()> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    tracing::info!("Derive WS connected");

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(tokio::sync::Mutex::new(write));

    // Subscribe for each supported currency
    for currency in SUPPORTED_CURRENCIES {
        let currency = currency.to_string();

        // Fetch + cache instrument names if not already done
        if !instruments_cache.contains_key(&currency) {
            match fetch_instruments(client, &currency).await {
                Ok(names) => {
                    tracing::info!(
                        "Derive: fetched {} instruments for {}",
                        names.len(),
                        currency
                    );
                    instruments_cache.insert(currency.clone(), names);
                }
                Err(e) => {
                    tracing::error!("Derive get_instruments error ({}): {}", currency, e);
                    continue;
                }
            }
        }

        let names = match instruments_cache.get(&currency) {
            Some(n) => n.clone(),
            None => continue,
        };

        // Bootstrap spot if not cached
        {
            let spot_cache = state.derive_spot.read().await;
            let has_spot = spot_cache.get(&currency).copied().unwrap_or(0.0) > 0.0;
            drop(spot_cache);
            if !has_spot {
                if let Err(e) = bootstrap_spot(state, client, &currency).await {
                    tracing::error!("Derive spot bootstrap error ({}): {}", currency, e);
                }
            }
        }

        // Bootstrap tickers if cache is cold for this currency
        {
            let ticker_cache = state.derive_tickers.read().await;
            let cache_hit = ticker_cache
                .keys()
                .any(|k| k.starts_with(&format!("{}-", currency)));
            drop(ticker_cache);
            if !cache_hit {
                if let Err(e) = bootstrap_tickers(state, client, &currency, &names).await {
                    tracing::error!("Derive ticker bootstrap error ({}): {}", currency, e);
                }
            }
        }

        // Build tiered channel list
        let expiries: Vec<String> = {
            let mut set: Vec<String> = names
                .iter()
                .filter_map(|n| {
                    let parts: Vec<&str> = n.split('-').collect();
                    if parts.len() >= 4
                        && parts[1].len() == 8
                        && parts[1].chars().all(|c| c.is_ascii_digit())
                    {
                        Some(parts[1].to_string())
                    } else {
                        None
                    }
                })
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            set.sort();
            set
        };

        let fast_set: HashSet<&str> = expiries
            .iter()
            .take(FAST_EXPIRIES)
            .map(|s| s.as_str())
            .collect();

        let all_channels: Vec<String> = names
            .iter()
            .map(|n| {
                let expiry = n.split('-').nth(1).unwrap_or("");
                if fast_set.contains(expiry) {
                    format!("ticker_slim.{}.100", n)
                } else {
                    format!("ticker_slim.{}.1000", n)
                }
            })
            .collect();

        let fast_count = names
            .iter()
            .filter(|n| {
                let expiry = n.split('-').nth(1).unwrap_or("");
                fast_set.contains(expiry)
            })
            .count();
        let slow_count = names.len() - fast_count;
        tracing::info!(
            "Derive WS: subscribing {} — {} fast (100ms) + {} slow (1000ms)",
            currency,
            fast_count,
            slow_count
        );

        // Send in chunks of 200
        for (chunk_idx, chunk) in all_channels.chunks(CHUNK).enumerate() {
            let channels: Vec<Value> = chunk.iter().map(|c| Value::String(c.clone())).collect();
            let sub_msg = json!({
                "method": "subscribe",
                "params": { "channels": channels },
                "id": format!("sub-{}-{}", currency, chunk_idx)
            });
            let mut w = write.lock().await;
            w.send(Message::Text(sub_msg.to_string())).await?;
        }
    }

    // Heartbeat task: every 25s
    let write_hb = write.clone();
    let hb_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(25)).await;
            let hb = json!({
                "method": "public/heartbeat",
                "params": {},
                "id": "hb"
            });
            let mut w = write_hb.lock().await;
            if w.send(Message::Text(hb.to_string())).await.is_err() {
                break;
            }
        }
    });

    // Read loop
    while let Some(msg_result) = read.next().await {
        let msg = msg_result?;
        match msg {
            Message::Text(text) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    handle_ws_message(state, &parsed).await;
                }
            }
            Message::Ping(data) => {
                let mut w = write.lock().await;
                let _ = w.send(Message::Pong(data)).await;
            }
            Message::Close(_) => {
                tracing::info!("Derive WS received close frame");
                break;
            }
            _ => {}
        }
    }

    hb_handle.abort();
    Ok(())
}

async fn fetch_instruments(client: &reqwest::Client, currency: &str) -> Result<Vec<String>> {
    let body: Value = client
        .post(format!("{}/public/get_all_instruments", DERIVE_REST))
        .header("Content-Type", "application/json")
        .header("User-Agent", "options-viewer/1.0")
        .json(&json!({
            "expired": false,
            "instrument_type": "option",
            "currency": currency,
            "page_size": 1000
        }))
        .send()
        .await?
        .json()
        .await?;

    let names: Vec<String> = body["result"]["instruments"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|i| i["instrument_name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(names)
}

async fn bootstrap_spot(state: &AppState, client: &reqwest::Client, currency: &str) -> Result<()> {
    let body: Value = client
        .post(format!("{}/public/get_ticker", DERIVE_REST))
        .header("Content-Type", "application/json")
        .header("User-Agent", "options-viewer/1.0")
        .json(&json!({ "instrument_name": format!("{}-PERP", currency) }))
        .send()
        .await?
        .json()
        .await?;

    let price = parse_f64_value(&body["result"]["index_price"])
        .max(parse_f64_value(&body["result"]["mark_price"]));

    if price > 0.0 {
        let mut spot_cache = state.derive_spot.write().await;
        spot_cache.insert(currency.to_string(), price);
        tracing::info!("Derive: bootstrapped spot {} = {}", currency, price);
    }

    Ok(())
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
    last: f64,
    mark_price: f64,
    volume: f64,
    open_interest: f64,
    bid_size: f64,
    ask_size: f64,
    delta: f64,
    gamma: f64,
    theta: f64,
    vega: f64,
    iv: f64,
) -> bool {
    bid > 0.0
        || ask > 0.0
        || last > 0.0
        || mark_price > 0.0
        || volume > 0.0
        || open_interest > 0.0
        || bid_size > 0.0
        || ask_size > 0.0
        || delta != 0.0
        || gamma != 0.0
        || theta != 0.0
        || vega != 0.0
        || iv > 0.0
}

async fn bootstrap_tickers(
    state: &AppState,
    client: &reqwest::Client,
    currency: &str,
    names: &[String],
) -> Result<()> {
    let mut expiry_set: HashSet<String> = HashSet::new();
    for name in names {
        let parts: Vec<&str> = name.split('-').collect();
        if parts.len() >= 4 && parts[1].len() == 8 && parts[1].chars().all(|c| c.is_ascii_digit()) {
            expiry_set.insert(parts[1].to_string());
        }
    }

    let mut total = 0usize;
    for expiry_date in &expiry_set {
        match client
            .post(format!("{}/public/get_tickers", DERIVE_REST))
            .header("Content-Type", "application/json")
            .header("User-Agent", "options-viewer/1.0")
            .json(&json!({
                "instrument_type": "option",
                "currency": currency,
                "expiry_date": expiry_date
            }))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(body) = resp.json::<Value>().await {
                    if let Some(tickers) = body["result"]["tickers"].as_object() {
                        let mut cache = state.derive_tickers.write().await;
                        for (name, data) in tickers {
                            cache.insert(name.clone(), data.clone());
                            total += 1;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::error!(
                    "Derive bootstrap tickers error ({} {}): {}",
                    currency,
                    expiry_date,
                    e
                );
            }
        }
    }

    tracing::info!(
        "Derive bootstrap done ({}): {} instruments cached",
        currency,
        total
    );
    Ok(())
}

async fn handle_ws_message(state: &AppState, msg: &Value) {
    if msg["method"].as_str() != Some("subscription") {
        return;
    }

    let params = match msg.get("params") {
        Some(p) => p,
        None => return,
    };

    let channel = match params["channel"].as_str() {
        Some(c) => c,
        None => return,
    };

    let instrument_ticker = match params["data"]["instrument_ticker"].as_object() {
        Some(t) => t.clone(),
        None => return,
    };

    // Parse instrument name: channel = "ticker_slim.BTC-20260307-70000-C.100"
    // Take parts[1..len-1] joined with "."
    let parts: Vec<&str> = channel.split('.').collect();
    if parts.len() < 3 {
        return;
    }
    let instrument = parts[1..parts.len() - 1].join(".");

    // Extract currency from instrument name
    let currency = match instrument.split('-').next() {
        Some(c) => c.to_string(),
        None => return,
    };

    // Update spot from index price field "I"
    let index_price = instrument_ticker
        .get("I")
        .map(parse_f64_value)
        .unwrap_or(0.0);
    if index_price > 0.0 {
        let mut spot_cache = state.derive_spot.write().await;
        spot_cache.insert(currency.clone(), index_price);
    }

    // Store ticker
    {
        let mut ticker_cache = state.derive_tickers.write().await;
        ticker_cache.insert(instrument.clone(), Value::Object(instrument_ticker));
    }

    // Mark dirty for throttled broadcast (flush task handles actual broadcast)
    if let Some(flag) = state.derive_dirty.get(currency.as_str()) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

fn parse_instrument_name(name: &str) -> Option<(String, f64, &'static str)> {
    // Format: BTC-20260307-70000-C
    // parts[0]=currency, parts[1]=YYYYMMDD, parts[2]=strike, parts[3]=C|P
    let parts: Vec<&str> = name.split('-').collect();
    if parts.len() < 4 {
        return None;
    }

    let date_str = parts[1];
    if date_str.len() != 8 || !date_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    // Parse YYYYMMDD
    let year = &date_str[0..4];
    let month = &date_str[4..6];
    let day = &date_str[6..8];
    let expiry = format!("{}-{}-{}", year, month, day);

    let strike: f64 = parts[2].parse().ok()?;
    let option_type: &'static str = if parts[3] == "C" { "call" } else { "put" };

    Some((expiry, strike, option_type))
}

pub fn build_response(
    tickers: &crate::cache::DeriveTickersCache,
    spot_cache: &crate::cache::DeriveSpotCache,
    coin: &str,
) -> Option<Value> {
    let spot_price = spot_cache.get(coin).copied().unwrap_or(0.0);

    let prefix = format!("{}-", coin);
    let mut options_by_date: HashMap<String, (Vec<Value>, Vec<Value>)> = HashMap::new();

    for (name, ticker) in tickers {
        if !name.starts_with(&prefix) {
            continue;
        }

        let (expiry, strike, option_type) = match parse_instrument_name(name) {
            Some(p) => p,
            None => continue,
        };

        let bid = parse_f64_value(&ticker["b"]);
        let ask = parse_f64_value(&ticker["a"]);
        let last = parse_f64_value(&ticker["f"]);
        let bid_size = parse_f64_value(&ticker["B"]);
        let ask_size = parse_f64_value(&ticker["A"]);
        let mark_price = parse_f64_value(&ticker["option_pricing"]["m"])
            .max(parse_f64_value(&ticker["M"]));

        let delta = parse_f64_value(&ticker["option_pricing"]["d"]);
        let gamma = parse_f64_value(&ticker["option_pricing"]["g"]);
        let theta = parse_f64_value(&ticker["option_pricing"]["t"]);
        let vega = parse_f64_value(&ticker["option_pricing"]["v"]);
        let iv = parse_f64_value(&ticker["option_pricing"]["i"]);
        let volume = parse_f64_value(&ticker["stats"]["v"]);
        let open_interest = parse_f64_value(&ticker["stats"]["oi"]);

        if !has_contract_signal(
            bid,
            ask,
            last,
            mark_price,
            volume,
            open_interest,
            bid_size,
            ask_size,
            delta,
            gamma,
            theta,
            vega,
            iv,
        ) {
            continue;
        }

        let contract = json!({
            "symbol":            name,
            "strike":            strike,
            "optionType":        option_type,
            "bid":               bid,
            "ask":               ask,
            "last":              last,
            "markPrice":         mark_price,
            "volume":            volume,
            "openInterest":      open_interest,
            "bidSize":           bid_size,
            "askSize":           ask_size,
            "delta":             delta,
            "gamma":             gamma,
            "theta":             theta,
            "vega":              vega,
            "impliedVolatility": iv,
            "markVol":           iv,
        });

        let entry = options_by_date
            .entry(expiry)
            .or_insert_with(|| (vec![], vec![]));
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
        let (calls, puts) = &options_by_date[date];
        expiration_counts.insert(
            date.clone(),
            json!({ "calls": calls.len(), "puts": puts.len() }),
        );
        data_obj.insert(
            date.clone(),
            json!({
                "calls": calls,
                "puts": puts,
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
    use super::build_response;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn build_response_parses_string_encoded_derive_fields() {
        let mut tickers = HashMap::new();
        tickers.insert(
            "BTC-20260314-70000-C".to_string(),
            json!({
                "b": "120.5",
                "a": "130.5",
                "f": "126.0",
                "B": "1.2",
                "A": "2.3",
                "M": "127.0",
                "option_pricing": {
                    "m": "127.1",
                    "d": "0.52",
                    "g": "0.0004",
                    "t": "-12.5",
                    "v": "45.2",
                    "i": "0.61"
                },
                "stats": {
                    "v": "15.5",
                    "oi": "80.25"
                }
            }),
        );

        let mut spot = HashMap::new();
        spot.insert("BTC".to_string(), 71234.5);

        let response = build_response(&tickers, &spot, "BTC").expect("derive response");
        let contract = &response["data"]["2026-03-14"]["calls"][0];

        assert_eq!(response["spotPrice"], json!(71234.5));
        assert_eq!(contract["bid"], json!(120.5));
        assert_eq!(contract["ask"], json!(130.5));
        assert_eq!(contract["markPrice"], json!(127.1));
        assert_eq!(contract["delta"], json!(0.52));
        assert_eq!(contract["gamma"], json!(0.0004));
        assert_eq!(contract["theta"], json!(-12.5));
        assert_eq!(contract["vega"], json!(45.2));
        assert_eq!(contract["markVol"], json!(0.61));
        assert_eq!(contract["openInterest"], json!(80.25));
    }
}
