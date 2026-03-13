use crate::state::AppState;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

const COINS: &[&str] = &["BTC", "ETH", "SOL"];

pub fn start_polling(state: Arc<AppState>, client: reqwest::Client) {
    for (i, coin) in COINS.iter().enumerate() {
        let state = state.clone();
        let client = client.clone();
        let coin = coin.to_string();
        tokio::spawn(async move {
            // Stagger start: 0ms, 333ms, 666ms
            if i > 0 {
                sleep(Duration::from_millis(333 * i as u64)).await;
            }
            loop {
                if let Err(e) = poll_once(&state, &client, &coin).await {
                    tracing::error!("Bybit poll error ({}): {}", coin, e);
                }
                sleep(Duration::from_millis(1000)).await;
            }
        });
    }
    tracing::info!("Bybit REST polling started (1s per coin, staggered 333ms)");
}

async fn poll_once(state: &AppState, client: &reqwest::Client, coin: &str) -> Result<()> {
    let url = format!(
        "https://api.bybit.com/v5/market/tickers?category=option&baseCoin={}",
        coin
    );
    let resp = client
        .get(&url)
        .header("User-Agent", "bybit-options-viewer/1.0")
        .send()
        .await?;
    let body: Value = resp.json().await?;
    let list = body["result"]["list"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        return Ok(());
    }

    // Extract spot price from first element's indexPrice
    let spot = list[0]["indexPrice"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    {
        let mut ticker_cache = state.bybit_ticker.write().await;
        let coin_map = ticker_cache
            .entry(coin.to_string())
            .or_insert_with(HashMap::new);
        for t in &list {
            let symbol = t["symbol"].as_str().unwrap_or("").to_string();
            if symbol.is_empty() {
                continue;
            }
            coin_map.insert(symbol, normalize_ticker(t));
        }
    }

    if spot > 0.0 {
        let mut spot_cache = state.bybit_spot.write().await;
        spot_cache.insert(coin.to_string(), spot);
    }

    // Build response and broadcast SSE
    let (ticker_snap, spot_snap) = {
        let t = state.bybit_ticker.read().await;
        let s = state.bybit_spot.read().await;
        (t.clone(), s.clone())
    };
    let data = build_response(&ticker_snap, &spot_snap, coin);
    if !data.is_null() {
        let payload = json!({ "tickers": data["data"], "spotPrice": data["spotPrice"] });
        let key = format!("bybit:{}", coin);
        crate::sse::broadcast(&state.sse_senders, &key, payload.to_string()).await;
    }

    Ok(())
}

fn normalize_ticker(t: &Value) -> Value {
    json!({
        "symbol":            t["symbol"].as_str().unwrap_or(""),
        "bid1Price":         t["bid1Price"].as_str().unwrap_or("0"),
        "ask1Price":         t["ask1Price"].as_str().unwrap_or("0"),
        "lastPrice":         t["lastPrice"].as_str().unwrap_or("0"),
        "volume24h":         t["volume24h"].as_str().unwrap_or("0"),
        "bid1Size":          t["bid1Size"].as_str().unwrap_or("0"),
        "ask1Size":          t["ask1Size"].as_str().unwrap_or("0"),
        "delta":             t["delta"].as_str().unwrap_or("0"),
        "gamma":             t["gamma"].as_str().unwrap_or("0"),
        "theta":             t["theta"].as_str().unwrap_or("0"),
        "vega":              t["vega"].as_str().unwrap_or("0"),
        "impliedVolatility": t["markIv"].as_str().unwrap_or("0"),
        "bid1Iv":            t["bid1Iv"].as_str().unwrap_or("0"),
        "ask1Iv":            t["ask1Iv"].as_str().unwrap_or("0"),
        "openInterest":      t["openInterest"].as_str().unwrap_or("0"),
        "markPrice":         t["markPrice"].as_str().unwrap_or("0"),
        "underlyingPrice":   t["underlyingPrice"].as_str().unwrap_or("0"),
        "indexPrice":        t["indexPrice"].as_str().unwrap_or("0"),
    })
}

pub struct ParsedSymbol {
    pub expiry_date: String,
    pub strike_price: f64,
    pub option_type: String, // "call" or "put"
}

pub fn parse_symbol(symbol: &str) -> Option<ParsedSymbol> {
    let parts: Vec<&str> = symbol.split('-').collect();
    if parts.len() < 4 {
        return None;
    }
    let date_str = parts[1];
    let strike: f64 = parts[2].parse().ok()?;
    let option_type = if parts[3] == "C" { "call" } else { "put" };

    let (day, month_str, year_str) = if date_str.len() == 6 {
        // DMMMYY
        (
            &date_str[..1],
            &date_str[1..4],
            &date_str[4..6],
        )
    } else if date_str.len() == 7 {
        // DDMMMYY
        (
            &date_str[..2],
            &date_str[2..5],
            &date_str[5..7],
        )
    } else {
        return None;
    };

    let day: u32 = day.parse().ok()?;
    let year: u32 = format!("20{}", year_str).parse().ok()?;
    let month: u32 = match month_str {
        "JAN" => 1, "FEB" => 2, "MAR" => 3, "APR" => 4,
        "MAY" => 5, "JUN" => 6, "JUL" => 7, "AUG" => 8,
        "SEP" => 9, "OCT" => 10, "NOV" => 11, "DEC" => 12,
        _ => return None,
    };

    let expiry_date = format!("{}-{:02}-{:02}", year, month, day);

    Some(ParsedSymbol {
        expiry_date,
        strike_price: strike,
        option_type: option_type.to_string(),
    })
}

fn parse_f64(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

pub fn build_response(
    ticker_cache: &crate::cache::BybitTickerCache,
    spot_cache: &crate::cache::BybitSpotCache,
    coin: &str,
) -> Value {
    let tickers = match ticker_cache.get(coin) {
        Some(m) => m.values().cloned().collect::<Vec<_>>(),
        None => return Value::Null,
    };
    if tickers.is_empty() {
        return Value::Null;
    }
    let spot_price = spot_cache.get(coin).copied().unwrap_or(0.0);

    let mut options_by_date: HashMap<String, (Vec<Value>, Vec<Value>, f64)> = HashMap::new();

    for ticker in &tickers {
        let symbol = ticker["symbol"].as_str().unwrap_or("");
        let parsed = match parse_symbol(symbol) {
            Some(p) => p,
            None => continue,
        };

        let option_data = json!({
            "symbol":            symbol,
            "strike":            parsed.strike_price,
            "optionType":        parsed.option_type,
            "bid":               parse_f64(&ticker["bid1Price"]),
            "ask":               parse_f64(&ticker["ask1Price"]),
            "last":              parse_f64(&ticker["lastPrice"]),
            "volume":            parse_f64(&ticker["volume24h"]),
            "bidSize":           parse_f64(&ticker["bid1Size"]),
            "askSize":           parse_f64(&ticker["ask1Size"]),
            "delta":             parse_f64(&ticker["delta"]),
            "gamma":             parse_f64(&ticker["gamma"]),
            "theta":             parse_f64(&ticker["theta"]),
            "vega":              parse_f64(&ticker["vega"]),
            "impliedVolatility": parse_f64(&ticker["impliedVolatility"]),
            "markVol":           parse_f64(&ticker["impliedVolatility"]),
            "bidVol":            parse_f64(&ticker["bid1Iv"]),
            "askVol":            parse_f64(&ticker["ask1Iv"]),
            "openInterest":      parse_f64(&ticker["openInterest"]),
            "markPrice":         parse_f64(&ticker["markPrice"]),
        });

        let entry = options_by_date
            .entry(parsed.expiry_date.clone())
            .or_insert_with(|| {
                let fwd = parse_f64(&ticker["underlyingPrice"]);
                (vec![], vec![], fwd)
            });

        if parsed.option_type == "call" {
            entry.0.push(option_data);
        } else {
            entry.1.push(option_data);
        }
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

/// Calculate days from now to expiry date (YYYY-MM-DD), assuming 08:00 UTC expiry
pub fn time_to_expiration_days(expiration: &str) -> f64 {
    // Parse YYYY-MM-DD
    let parts: Vec<&str> = expiration.split('-').collect();
    if parts.len() != 3 {
        return 0.0;
    }
    let year: i64 = parts[0].parse().unwrap_or(0);
    let month: i64 = parts[1].parse().unwrap_or(0);
    let day: i64 = parts[2].parse().unwrap_or(0);

    // Days in each month (non-leap year approximation; good enough for DTE)
    // Use a simple approach: compute days since epoch for both dates
    let expiry_secs = date_to_unix(year, month, day) + 8 * 3600; // 08:00 UTC
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let diff = expiry_secs - now_secs;
    if diff <= 0 {
        0.0
    } else {
        diff as f64 / 86400.0
    }
}

fn date_to_unix(year: i64, month: i64, day: i64) -> i64 {
    // Days from 1970-01-01 to year-month-day
    let days = days_from_epoch(year, month, day);
    days * 86400
}

fn days_from_epoch(year: i64, month: i64, day: i64) -> i64 {
    // Compute days since 1970-01-01 using proleptic Gregorian calendar
    let y = if month <= 2 { year - 1 } else { year };
    let m = if month <= 2 { month + 12 } else { month };
    let d = day;

    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m - 3) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468 // days since 1970-01-01
}
