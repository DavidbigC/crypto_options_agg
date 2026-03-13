use crate::state::AppState;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{sleep, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tokio::net::TcpStream;
use futures_util::stream::SplitSink;

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

const FAMILIES: &[&str] = &["BTC-USD", "ETH-USD"];
const WS_URL: &str = "wss://ws.okx.com:8443/ws/v5/public";

pub fn start(state: Arc<AppState>, client: reqwest::Client) {
    // Start WS for Greeks
    start_ws(state.clone());

    // Start ticker REST polling for each family (staggered 1s apart)
    for (i, family) in FAMILIES.iter().enumerate() {
        let state = state.clone();
        let client = client.clone();
        let family = family.to_string();
        tokio::spawn(async move {
            if i > 0 {
                sleep(Duration::from_millis(1000 * i as u64)).await;
            }
            poll_tickers(state, client, family).await;
        });
    }

    // Start spot polling
    {
        let state = state.clone();
        let client = client.clone();
        tokio::spawn(async move {
            poll_spots(state, client).await;
        });
    }

    tracing::info!("OKX WS + REST polling started");
}

fn start_ws(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut backoff = 2u64;
        loop {
            match run_ws(state.clone()).await {
                Ok(_) => {
                    tracing::warn!("OKX WS closed cleanly, reconnecting in {}s", backoff);
                }
                Err(e) => {
                    tracing::error!("OKX WS error: {}, reconnecting in {}s", e, backoff);
                }
            }
            sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
}

async fn run_ws(state: Arc<AppState>) -> Result<()> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    tracing::info!("OKX WS connected");

    let (write, mut read) = ws_stream.split();
    let write = Arc::new(tokio::sync::Mutex::new(write));

    // Subscribe to opt-summary for each family
    let args: Vec<Value> = FAMILIES
        .iter()
        .map(|f| json!({"channel": "opt-summary", "instFamily": f}))
        .collect();
    let sub_msg = json!({"op": "subscribe", "args": args});
    {
        let mut w = write.lock().await;
        w.send(Message::Text(sub_msg.to_string())).await?;
    }

    // Heartbeat task: send "ping" every 25s
    let write_hb = write.clone();
    let hb_handle = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(25)).await;
            let mut w = write_hb.lock().await;
            if w.send(Message::Text("ping".to_string())).await.is_err() {
                break;
            }
        }
    });

    // Read loop
    while let Some(msg_result) = read.next().await {
        let msg = msg_result?;
        match msg {
            Message::Text(text) => {
                if text == "pong" {
                    continue;
                }
                if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                    handle_ws_message(&state, &parsed).await;
                }
            }
            Message::Ping(data) => {
                let mut w = write.lock().await;
                let _ = w.send(Message::Pong(data)).await;
            }
            Message::Close(_) => {
                tracing::info!("OKX WS received close frame");
                break;
            }
            _ => {}
        }
    }

    hb_handle.abort();
    Ok(())
}

async fn handle_ws_message(state: &AppState, msg: &Value) {
    // Check for data field
    let data = match msg["data"].as_array() {
        Some(d) if !d.is_empty() => d,
        _ => return,
    };

    let inst_family = match msg["arg"]["instFamily"].as_str() {
        Some(f) => f.to_string(),
        None => return,
    };

    let mut greeks_cache = state.okx_greeks.write().await;
    let family_map = greeks_cache
        .entry(inst_family.clone())
        .or_insert_with(HashMap::new);

    for item in data {
        let inst_id = match item["instId"].as_str() {
            Some(id) => id.to_string(),
            None => continue,
        };
        family_map.insert(inst_id, item.clone());
    }
    drop(greeks_cache);
}

async fn poll_tickers(state: Arc<AppState>, client: reqwest::Client, family: String) {
    loop {
        match fetch_tickers(&client, &family).await {
            Ok(tickers) => {
                if !tickers.is_empty() {
                    {
                        let mut ticker_cache = state.okx_ticker.write().await;
                        let family_map = ticker_cache
                            .entry(family.clone())
                            .or_insert_with(HashMap::new);
                        for t in &tickers {
                            let inst_id = t["instId"].as_str().unwrap_or("").to_string();
                            if !inst_id.is_empty() {
                                family_map.insert(inst_id, t.clone());
                            }
                        }
                    }

                    // Build and broadcast SSE
                    let (greeks_snap, ticker_snap, spot_snap) = {
                        let g = state.okx_greeks.read().await;
                        let t = state.okx_ticker.read().await;
                        let s = state.okx_spot.read().await;
                        (g.clone(), t.clone(), s.clone())
                    };
                    let data = build_response(&greeks_snap, &ticker_snap, &spot_snap, &family);
                    if !data.is_null() {
                        let payload = json!({ "tickers": data["data"], "spotPrice": data["spotPrice"] });
                        let key = format!("okx:{}", family);
                        crate::sse::broadcast(&state.sse_senders, &key, payload.to_string()).await;
                    }
                }
            }
            Err(e) => {
                tracing::error!("OKX ticker poll error ({}): {}", family, e);
            }
        }
        sleep(Duration::from_millis(1000)).await;
    }
}

async fn fetch_tickers(client: &reqwest::Client, family: &str) -> Result<Vec<Value>> {
    let url = format!(
        "https://www.okx.com/api/v5/market/tickers?instType=OPTION&instFamily={}",
        family
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "okx-options-viewer/1.0")
        .send()
        .await?;
    let body: Value = resp.json().await?;
    let list = body["data"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(list)
}

async fn poll_spots(state: Arc<AppState>, client: reqwest::Client) {
    let spot_ids = ["BTC-USDT", "ETH-USDT"];
    loop {
        for inst_id in &spot_ids {
            match fetch_spot(&client, inst_id).await {
                Ok(price) => {
                    if price > 0.0 {
                        let mut spot_cache = state.okx_spot.write().await;
                        spot_cache.insert(inst_id.to_string(), price);
                    }
                }
                Err(e) => {
                    tracing::error!("OKX spot poll error ({}): {}", inst_id, e);
                }
            }
        }
        sleep(Duration::from_secs(5)).await;
    }
}

async fn fetch_spot(client: &reqwest::Client, inst_id: &str) -> Result<f64> {
    let url = format!(
        "https://www.okx.com/api/v5/market/ticker?instId={}",
        inst_id
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "okx-options-viewer/1.0")
        .send()
        .await?;
    let body: Value = resp.json().await?;
    let price = body["data"][0]["last"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok(price)
}

/// Parse OKX instId: BTC-USD-250328-70000-C
/// Returns (expiryDate, strikePrice, optionType)
fn parse_inst_id(inst_id: &str) -> Option<(String, f64, String)> {
    let parts: Vec<&str> = inst_id.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let date_str = parts[2]; // YYMMDD
    if date_str.len() != 6 {
        return None;
    }
    let strike: f64 = parts[3].parse().ok()?;
    let option_type = if parts[4] == "C" { "call" } else { "put" };

    // "250328" -> "2025-03-28"
    let yy = &date_str[0..2];
    let mm = &date_str[2..4];
    let dd = &date_str[4..6];
    let expiry = format!("20{}-{}-{}", yy, mm, dd);

    Some((expiry, strike, option_type.to_string()))
}

fn parse_f64_value(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn build_response(
    okx_greeks: &crate::cache::OkxGreeksCache,
    okx_ticker: &crate::cache::OkxTickerCache,
    okx_spot: &crate::cache::OkxSpotCache,
    inst_family: &str,
) -> Value {
    let greeks_map = match okx_greeks.get(inst_family) {
        Some(m) => m,
        None => return Value::Null,
    };
    if greeks_map.is_empty() {
        return Value::Null;
    }

    let empty_ticker_map = HashMap::new();
    let ticker_map = okx_ticker.get(inst_family).unwrap_or(&empty_ticker_map);

    // Determine spot price from family
    let spot_key = if inst_family.starts_with("BTC") {
        "BTC-USDT"
    } else {
        "ETH-USDT"
    };
    let spot_price = okx_spot.get(spot_key).copied().unwrap_or(0.0);

    // Group by expiry: date -> { calls, puts, forwardPrice }
    let mut options_by_date: HashMap<String, (Vec<Value>, Vec<Value>, f64)> = HashMap::new();

    for (inst_id, item) in greeks_map {
        let (expiry, strike, option_type) = match parse_inst_id(inst_id) {
            Some(p) => p,
            None => continue,
        };

        let ticker = ticker_map.get(inst_id);

        let bid = ticker
            .and_then(|t| t["bidPx"].as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let ask = ticker
            .and_then(|t| t["askPx"].as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let last = ticker
            .and_then(|t| t["last"].as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);

        // volume: prefer ticker vol24h, fallback to item vol24h
        let volume = ticker
            .map(|t| parse_f64_value(&t["vol24h"]))
            .filter(|&v| v > 0.0)
            .unwrap_or_else(|| parse_f64_value(&item["vol24h"]));

        let bid_sz = ticker.map(|t| parse_f64_value(&t["bidSz"])).unwrap_or(0.0);
        let ask_sz = ticker.map(|t| parse_f64_value(&t["askSz"])).unwrap_or(0.0);

        let delta = parse_f64_value(&item["delta"]);
        let gamma_raw = parse_f64_value(&item["gamma"]);
        let theta_raw = parse_f64_value(&item["theta"]);
        let vega_raw = parse_f64_value(&item["vega"]);
        let mark_vol = parse_f64_value(&item["markVol"]);
        let bid_vol = parse_f64_value(&item["bidVol"]);
        let ask_vol = parse_f64_value(&item["askVol"]);
        let oi = parse_f64_value(&item["oi"]);
        let fwd_px = parse_f64_value(&item["fwdPx"]);

        let gamma = if spot_price > 0.0 { gamma_raw / spot_price } else { 0.0 };
        let theta = theta_raw * spot_price;
        let vega = vega_raw * spot_price;

        let contract = json!({
            "symbol":            inst_id,
            "strike":            strike,
            "optionType":        option_type,
            "bid":               bid,
            "ask":               ask,
            "last":              last,
            "volume":            volume,
            "bidSize":           bid_sz,
            "askSize":           ask_sz,
            "delta":             delta,
            "gamma":             gamma,
            "theta":             theta,
            "vega":              vega,
            "impliedVolatility": mark_vol,
            "openInterest":      oi,
            "markPrice":         0.0,
            "markVol":           mark_vol,
            "bidVol":            bid_vol,
            "askVol":            ask_vol,
        });

        let entry = options_by_date
            .entry(expiry.clone())
            .or_insert_with(|| (vec![], vec![], fwd_px));

        // Note: fwdPx is set from first item (or_insert_with keeps the first)
        if option_type == "call" {
            entry.0.push(contract);
        } else {
            entry.1.push(contract);
        }
    }

    if options_by_date.is_empty() {
        return Value::Null;
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

    json!({
        "spotPrice": spot_price,
        "expirations": sorted_dates,
        "expirationCounts": expiration_counts,
        "data": data_obj,
    })
}
