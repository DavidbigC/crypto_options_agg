use crate::state::AppState;
use serde_json::json;
use std::sync::Arc;

const COINS: &[&str] = &["BTC", "ETH", "SOL"];

pub fn start_polling(state: Arc<AppState>, client: reqwest::Client) {
    for &coin in COINS {
        let state = state.clone();
        let client = client.clone();
        let coin = coin.to_string();
        tokio::spawn(async move {
            loop {
                refresh(&state, &client, &coin).await;
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
            }
        });
    }
    tracing::info!("Futures polling started (10s)");
}

async fn refresh(state: &AppState, client: &reqwest::Client, coin: &str) {
    let (bybit_res, okx_res, deribit_res) = tokio::join!(
        poll_bybit(client, coin),
        poll_okx(client, coin),
        poll_deribit(client, coin),
    );
    let mut rows: Vec<serde_json::Value> = Vec::new();
    if let Ok(r) = bybit_res { rows.extend(r); }
    if let Ok(r) = okx_res   { rows.extend(r); }
    if let Ok(r) = deribit_res { rows.extend(r); }
    sort_futures(&mut rows);
    state.futures.write().await.insert(coin.to_string(), rows);
}

fn sort_futures(items: &mut Vec<serde_json::Value>) {
    items.sort_by(|a, b| {
        let a_perp = a["isPerp"].as_bool().unwrap_or(false);
        let b_perp = b["isPerp"].as_bool().unwrap_or(false);
        match (a_perp, b_perp) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let a_exp = a["expiry"].as_str().unwrap_or("");
                let b_exp = b["expiry"].as_str().unwrap_or("");
                a_exp.cmp(b_exp)
            }
        }
    });
}

/// Convert Unix timestamp in milliseconds to "YYYY-MM-DD" (UTC).
/// Uses the civil date algorithm by Howard Hinnant.
fn ts_millis_to_date(ts_ms: i64) -> String {
    let days = ts_ms / 86_400_000;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

async fn poll_bybit(client: &reqwest::Client, coin: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let url = format!("https://api.bybit.com/v5/market/tickers?category=inverse&baseCoin={coin}");
    let json: serde_json::Value = client.get(&url).send().await?.json().await?;
    let list = json["result"]["list"].as_array().cloned().unwrap_or_default();
    let mut items: Vec<serde_json::Value> = list.iter().map(|t| {
        let delivery = t["deliveryTime"].as_str().unwrap_or("0");
        let is_perp = delivery == "0";
        let expiry = if is_perp {
            serde_json::Value::Null
        } else {
            let ts: i64 = delivery.parse().unwrap_or(0);
            serde_json::Value::String(ts_millis_to_date(ts))
        };
        json!({
            "symbol":    t["symbol"],
            "exchange":  "bybit",
            "expiry":    expiry,
            "isPerp":    is_perp,
            "markPrice": t["markPrice"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "bid":       t["bid1Price"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "ask":       t["ask1Price"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "lastPrice": t["lastPrice"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
        })
    }).collect();
    sort_futures(&mut items);
    Ok(items)
}

/// OKX: "BTC-USD-260925" → "2026-09-25", "BTC-USD-SWAP" → None
fn parse_okx_expiry(inst_id: &str) -> Option<String> {
    let last = inst_id.split('-').last()?;
    if last == "SWAP" || last.len() != 6 { return None; }
    Some(format!("20{}-{}-{}", &last[0..2], &last[2..4], &last[4..6]))
}

async fn poll_okx(client: &reqwest::Client, coin: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let family = format!("{coin}-USD");
    let (fut_res, swap_res) = tokio::join!(
        client.get(format!("https://www.okx.com/api/v5/market/tickers?instType=FUTURES&instFamily={family}")).send(),
        client.get(format!("https://www.okx.com/api/v5/market/tickers?instType=SWAP&instFamily={family}")).send(),
    );
    let fut_json:  serde_json::Value = fut_res?.json().await?;
    let swap_json: serde_json::Value = swap_res?.json().await?;
    let empty = vec![];
    let all: Vec<&serde_json::Value> = swap_json["data"].as_array().unwrap_or(&empty).iter()
        .chain(fut_json["data"].as_array().unwrap_or(&empty).iter())
        .collect();
    let mut items: Vec<serde_json::Value> = Vec::new();
    for t in all {
        let inst_id = t["instId"].as_str().unwrap_or("");
        let is_perp = inst_id.ends_with("-SWAP");
        let expiry_val = if is_perp {
            serde_json::Value::Null
        } else {
            match parse_okx_expiry(inst_id) {
                Some(e) => serde_json::Value::String(e),
                None => continue,
            }
        };
        items.push(json!({
            "symbol":    inst_id,
            "exchange":  "okx",
            "expiry":    expiry_val,
            "isPerp":    is_perp,
            "markPrice": t["last"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "bid":       t["bidPx"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "ask":       t["askPx"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
            "lastPrice": t["last"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
        }));
    }
    sort_futures(&mut items);
    Ok(items)
}

const MONTHS: &[(&str, u32)] = &[
    ("JAN",1),("FEB",2),("MAR",3),("APR",4),("MAY",5),("JUN",6),
    ("JUL",7),("AUG",8),("SEP",9),("OCT",10),("NOV",11),("DEC",12),
];

/// Deribit: "BTC-13MAR26" → "2026-03-13", "BTC-PERPETUAL" → None
fn parse_deribit_expiry(name: &str) -> Option<String> {
    if name.contains("PERPETUAL") { return None; }
    let dash = name.find('-')?;
    let date_str = &name[dash + 1..]; // e.g. "13MAR26"
    if date_str.len() < 7 { return None; }
    let day: u32 = date_str[..2].parse().ok()?;
    let mon_str = &date_str[2..5];
    let month = MONTHS.iter().find(|(k, _)| *k == mon_str.to_uppercase())?.1;
    let year: u32 = 2000 + date_str[5..7].parse::<u32>().ok()?;
    Some(format!("{:04}-{:02}-{:02}", year, month, day))
}

async fn poll_deribit(client: &reqwest::Client, coin: &str) -> anyhow::Result<Vec<serde_json::Value>> {
    let currency = if coin == "SOL" { "SOL_USDC" } else { coin };
    let url = format!(
        "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency={currency}&kind=future"
    );
    let json: serde_json::Value = client.get(&url).send().await?.json().await?;
    let summaries = json["result"].as_array().cloned().unwrap_or_default();
    let mut items: Vec<serde_json::Value> = Vec::new();
    for s in &summaries {
        let name = s["instrument_name"].as_str().unwrap_or("");
        let is_perp = name.contains("PERPETUAL");
        let expiry_val = if is_perp {
            serde_json::Value::Null
        } else {
            match parse_deribit_expiry(name) {
                Some(e) => serde_json::Value::String(e),
                None => continue,
            }
        };
        items.push(json!({
            "symbol":    name,
            "exchange":  "deribit",
            "expiry":    expiry_val,
            "isPerp":    is_perp,
            "markPrice": s["mark_price"].as_f64().unwrap_or(0.0),
            "bid":       s["bid_price"].as_f64().unwrap_or(0.0),
            "ask":       s["ask_price"].as_f64().unwrap_or(0.0),
            "lastPrice": s["last"].as_f64().unwrap_or(0.0),
        }));
    }
    sort_futures(&mut items);
    Ok(items)
}
