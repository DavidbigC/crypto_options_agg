use crate::state::AppState;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const WS_URL: &str = "wss://www.deribit.com/ws/api/v2";
const DERIBIT_BASE: &str = "https://www.deribit.com/api/v2";

// (coin, currency, index_name, instrument_prefix)
const COINS: &[(&str, &str, &str, Option<&str>)] = &[
    ("BTC", "BTC",  "btc_usd", None),
    ("ETH", "ETH",  "eth_usd", None),
    ("SOL", "USDC", "sol_usd", Some("SOL_USDC")),
];

pub fn start(state: Arc<AppState>, client: reqwest::Client) {
    // Start REST polling for each coin (staggered 2s apart)
    for (i, &(coin, currency, index, prefix)) in COINS.iter().enumerate() {
        let state = state.clone();
        let client = client.clone();
        let coin = coin.to_string();
        let currency = currency.to_string();
        let index = index.to_string();
        let prefix = prefix.map(|s| s.to_string());
        tokio::spawn(async move {
            if i > 0 {
                sleep(Duration::from_millis(2000 * i as u64)).await;
            }
            poll_coin(state, client, coin, currency, index, prefix).await;
        });
    }

    // Start WebSocket for Greeks
    start_ws(state.clone(), client.clone());

    tracing::info!("Deribit REST polling + WS started");
}

async fn poll_coin(
    state: Arc<AppState>,
    client: reqwest::Client,
    coin: String,
    currency: String,
    index: String,
    prefix: Option<String>,
) {
    loop {
        match poll_once(&state, &client, &coin, &currency, &index, prefix.as_deref()).await {
            Ok(_) => {}
            Err(e) => {
                tracing::error!("Deribit poll error ({}): {}", coin, e);
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
}

async fn poll_once(
    state: &AppState,
    client: &reqwest::Client,
    coin: &str,
    currency: &str,
    index: &str,
    prefix: Option<&str>,
) -> Result<()> {
    // Fetch spot price
    let spot_url = format!(
        "{}/public/get_index_price?index_name={}",
        DERIBIT_BASE, index
    );
    let spot_body: Value = client
        .get(&spot_url)
        .header("User-Agent", "deribit-options-viewer/1.0")
        .send()
        .await?
        .json()
        .await?;
    let spot = spot_body["result"]["index_price"]
        .as_f64()
        .unwrap_or(0.0);

    // Fetch book summaries
    let sum_url = format!(
        "{}/public/get_book_summary_by_currency?currency={}&kind=option",
        DERIBIT_BASE, currency
    );
    let sum_body: Value = client
        .get(&sum_url)
        .header("User-Agent", "deribit-options-viewer/1.0")
        .send()
        .await?
        .json()
        .await?;

    let summaries: Vec<Value> = sum_body["result"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| {
            if let Some(p) = prefix {
                s["instrument_name"]
                    .as_str()
                    .map(|n| n.starts_with(p))
                    .unwrap_or(false)
            } else {
                true
            }
        })
        .collect();

    // Update cache
    {
        let mut cache = state.deribit.write().await;
        let entry = cache.entry(coin.to_string()).or_default();
        if spot > 0.0 {
            entry.spot = spot;
        }
        entry.summaries = summaries;
    }

    // Build and broadcast SSE
    let payload = {
        let deribit = state.deribit.read().await;
        let greeks = state.deribit_greeks.read().await;
        build_response(&deribit, &greeks, coin)
    };
    if let Some(p) = payload {
        let key = format!("deribit:{}", coin);
        crate::sse::broadcast(&state.sse_senders, &key, p.to_string()).await;
    }

    Ok(())
}

fn start_ws(state: Arc<AppState>, client: reqwest::Client) {
    tokio::spawn(async move {
        let mut backoff = 2u64;
        loop {
            match run_ws(&state, &client).await {
                Ok(_) => {
                    tracing::info!("Deribit WS closed cleanly, reconnecting in 2s");
                    sleep(Duration::from_secs(2)).await;
                    backoff = 2;
                }
                Err(e) => {
                    tracing::warn!("Deribit WS error: {}, reconnecting in {}s", e, backoff);
                    sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    });
}

async fn run_ws(state: &AppState, client: &reqwest::Client) -> Result<()> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    tracing::info!("Deribit WS connected");

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(tokio::sync::Mutex::new(write));

    // Fetch instruments and subscribe in chunks of 200
    let mut all_channels: Vec<String> = Vec::new();
    for &(_, currency, _, prefix_filter) in COINS.iter() {
        let url = format!(
            "{}/public/get_instruments?currency={}&kind=option&expired=false",
            DERIBIT_BASE, currency
        );
        match client
            .get(&url)
            .header("User-Agent", "deribit-options-viewer/1.0")
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(body) = resp.json::<Value>().await {
                    let mut instruments: Vec<String> = body["result"]
                        .as_array()
                        .map(|arr| arr.iter()
                            .filter_map(|i| i["instrument_name"].as_str().map(String::from))
                            .collect())
                        .unwrap_or_default();

                    // Apply prefix filter (important for SOL_USDC: only subscribe to SOL options, not all USDC)
                    if let Some(prefix) = prefix_filter {
                        instruments.retain(|name| name.starts_with(prefix));
                    }

                    for name in instruments {
                        all_channels.push(format!("ticker.{}.100ms", name));
                    }
                }
            }
            Err(e) => {
                tracing::error!("Deribit get_instruments error ({}): {}", currency, e);
            }
        }
    }

    tracing::info!("Deribit WS subscribing to {} channels", all_channels.len());

    // Subscribe in chunks of 200
    for (chunk_idx, chunk) in all_channels.chunks(200).enumerate() {
        let channels: Vec<Value> = chunk.iter().map(|c| Value::String(c.clone())).collect();
        let sub_msg = json!({
            "jsonrpc": "2.0",
            "method": "public/subscribe",
            "params": { "channels": channels },
            "id": format!("sub_{}", chunk_idx)
        });
        let mut w = write.lock().await;
        w.send(Message::Text(sub_msg.to_string())).await?;
    }

    // Heartbeat task: every 25s
    let write_hb = write.clone();
    let hb_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(25)).await;
            let hb = json!({
                "jsonrpc": "2.0",
                "method": "public/test",
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
                tracing::info!("Deribit WS received close frame");
                break;
            }
            _ => {}
        }
    }

    hb_handle.abort();
    Ok(())
}

async fn handle_ws_message(state: &AppState, msg: &Value) {
    // Only handle subscription messages
    if msg["method"].as_str() != Some("subscription") {
        return;
    }
    let data = match msg.get("params").and_then(|p| p.get("data")) {
        Some(d) => d.clone(),
        None => return,
    };
    let channel = msg["params"]["channel"].as_str().unwrap_or("");
    // channel format: "ticker.BTC-27MAR26-70000-C.100ms"
    let parts: Vec<&str> = channel.split('.').collect();
    if parts.len() < 2 {
        return;
    }
    let instrument_name = parts[1];

    let mut greeks_cache = state.deribit_greeks.write().await;
    greeks_cache.insert(instrument_name.to_string(), data);
}

fn parse_instrument_name(name: &str) -> Option<(String, f64, &'static str)> {
    // Format: BTC-27MAR26-70000-C  or  SOL_USDC-27MAR26-200-C
    // Skip up to first '-', then parse: dateStr-strike-type
    let dash_idx = name.find('-')?;
    let rest = &name[dash_idx + 1..];
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 3 {
        return None;
    }

    let date_str = parts[0]; // e.g. "27MAR26" or "7MAR26"
    let strike: f64 = parts[1].parse().ok()?;
    let option_type: &'static str = if parts[2] == "C" { "call" } else { "put" };

    // Parse date: day (1-2 chars) + month (3 chars) + year (2 chars)
    let (day, month_str, year_str) = if date_str.len() == 6 {
        // 1-digit day: e.g. "7MAR26"
        (&date_str[0..1], &date_str[1..4], &date_str[4..6])
    } else if date_str.len() == 7 {
        // 2-digit day: e.g. "27MAR26"
        (&date_str[0..2], &date_str[2..5], &date_str[5..7])
    } else {
        return None;
    };

    let day_num: u32 = day.parse().ok()?;
    let month_num: u32 = match month_str {
        "JAN" => 1,  "FEB" => 2,  "MAR" => 3,  "APR" => 4,
        "MAY" => 5,  "JUN" => 6,  "JUL" => 7,  "AUG" => 8,
        "SEP" => 9,  "OCT" => 10, "NOV" => 11, "DEC" => 12,
        _ => return None,
    };
    let year: u32 = format!("20{}", year_str).parse().ok()?;

    let expiry = format!("{}-{:02}-{:02}", year, month_num, day_num);
    Some((expiry, strike, option_type))
}

pub fn build_response(
    deribit: &crate::cache::DeribitCache,
    deribit_greeks: &crate::cache::DeribitGreeksCache,
    coin: &str,
) -> Option<Value> {
    let cache = deribit.get(coin)?;
    if cache.summaries.is_empty() {
        return None;
    }

    let spot_price = cache.spot;
    // BTC/ETH: prices are in coin units → multiply by spot. SOL_USDC: already USD → mult=1
    let coin_mult = if coin == "SOL" { 1.0 } else { spot_price };

    let mut options_by_date: HashMap<String, (Vec<Value>, Vec<Value>, f64)> = HashMap::new();

    for s in &cache.summaries {
        let name = match s["instrument_name"].as_str() {
            Some(n) => n,
            None => continue,
        };
        let (expiry, strike, option_type) = match parse_instrument_name(name) {
            Some(p) => p,
            None => continue,
        };

        let bid = s["bid_price"].as_f64().unwrap_or(0.0) * coin_mult;
        let ask = s["ask_price"].as_f64().unwrap_or(0.0) * coin_mult;
        let last = s["last"].as_f64().unwrap_or(0.0) * coin_mult;
        let mark_price = s["mark_price"].as_f64().unwrap_or(0.0) * coin_mult;
        let volume = s["volume"].as_f64().unwrap_or(0.0);
        let open_interest = s["open_interest"].as_f64().unwrap_or(0.0);
        let mark_iv = s["mark_iv"].as_f64().unwrap_or(0.0) / 100.0;
        let forward_price = s["underlying_price"].as_f64().unwrap_or(0.0);

        let greeks = deribit_greeks.get(name);
        let delta = greeks
            .and_then(|g| g["greeks"]["delta"].as_f64())
            .unwrap_or(0.0);
        let gamma = greeks
            .and_then(|g| g["greeks"]["gamma"].as_f64())
            .unwrap_or(0.0);
        let theta = greeks
            .and_then(|g| g["greeks"]["theta"].as_f64())
            .unwrap_or(0.0);
        let vega = greeks
            .and_then(|g| g["greeks"]["vega"].as_f64())
            .unwrap_or(0.0);
        let bid_iv = greeks
            .and_then(|g| g["bid_iv"].as_f64())
            .map(|v| v / 100.0)
            .unwrap_or(0.0);
        let ask_iv = greeks
            .and_then(|g| g["ask_iv"].as_f64())
            .map(|v| v / 100.0)
            .unwrap_or(0.0);

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
            "bidSize":           0,
            "askSize":           0,
            "delta":             delta,
            "gamma":             gamma,
            "theta":             theta,
            "vega":              vega,
            "impliedVolatility": mark_iv,
            "markVol":           mark_iv,
            "bidVol":            bid_iv,
            "askVol":            ask_iv,
        });

        let entry = options_by_date
            .entry(expiry)
            .or_insert_with(|| (vec![], vec![], forward_price));

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
