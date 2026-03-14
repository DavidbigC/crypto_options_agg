use axum::{extract::State, response::IntoResponse, Json};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;

use crate::state::AppState;

const BYBIT_BASE_URL: &str = "https://api.bybit.com";
const RECV_WINDOW: &str = "5000";

fn parse_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn parse_option_date(raw: &str) -> Option<String> {
    let value = raw.to_uppercase();
    let months = [
        ("JAN", "01"), ("FEB", "02"), ("MAR", "03"), ("APR", "04"),
        ("MAY", "05"), ("JUN", "06"), ("JUL", "07"), ("AUG", "08"),
        ("SEP", "09"), ("OCT", "10"), ("NOV", "11"), ("DEC", "12"),
    ];

    // Match pattern: 1-2 digits, 3 letters, 2 digits
    let bytes = value.as_bytes();
    let mut i = 0;

    // Parse day digits
    let day_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == day_start || i - day_start > 2 {
        return None;
    }
    let day = &value[day_start..i];

    // Parse month letters
    let month_start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if i - month_start != 3 {
        return None;
    }
    let month_str = &value[month_start..i];

    // Parse year digits
    let year_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i - year_start != 2 || i != bytes.len() {
        return None;
    }
    let year = &value[year_start..i];

    let month_num = months.iter().find(|(m, _)| *m == month_str)?.1;

    let day_padded = format!("{:0>2}", day);
    Some(format!("20{}-{}-{}", year, month_num, day_padded))
}

fn parse_instrument(symbol: &str, category: &str) -> Value {
    let category_lower = category.to_lowercase();
    let upper_symbol = symbol.to_uppercase();

    if category_lower == "option" {
        let parts: Vec<&str> = upper_symbol.split('-').collect();
        if parts.len() >= 4 {
            let coin = parts[0].to_string();
            let option_type = if parts[3] == "C" { "call" } else { "put" };
            let expiry = parse_option_date(parts[1]);
            let strike: Option<f64> = parts[2].parse().ok();
            return json!({
                "coin": coin,
                "kind": "option",
                "optionType": option_type,
                "expiry": expiry,
                "strike": strike,
            });
        }
    }

    if category_lower == "linear" || category_lower == "inverse" {
        let coin = upper_symbol
            .trim_end_matches("USDT")
            .trim_end_matches("USDC")
            .trim_end_matches("USD")
            .trim_end_matches("PERP")
            .to_string();
        return json!({
            "coin": coin,
            "kind": "future",
            "optionType": null,
            "expiry": "perpetual",
            "strike": null,
        });
    }

    json!({
        "coin": "",
        "kind": "other",
        "optionType": null,
        "expiry": null,
        "strike": null,
    })
}

fn normalize_balances(balance_payload: &Value) -> Vec<Value> {
    let coins = balance_payload
        .get("result")
        .and_then(|r| r.get("list"))
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
        .and_then(|acc| acc.get("coin"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    let mut balances: Vec<Value> = coins
        .iter()
        .map(|coin| {
            let currency = coin
                .get("coin")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            json!({
                "currency": currency,
                "equity": parse_number(coin.get("equity").unwrap_or(&Value::Null)),
                "usdValue": parse_number(coin.get("usdValue").unwrap_or(&Value::Null)),
                "available": parse_number(coin.get("walletBalance").unwrap_or(&Value::Null)),
                "frozen": parse_number(coin.get("locked").unwrap_or(&Value::Null)),
                "upl": parse_number(coin.get("unrealisedPnl").unwrap_or(&Value::Null)),
            })
        })
        .filter(|b| {
            b.get("currency")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false)
        })
        .collect();

    balances.sort_by(|a, b| {
        let av = a.get("usdValue").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bv = b.get("usdValue").and_then(|v| v.as_f64()).unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
    balances
}

fn normalize_positions(position_payloads: &[Value]) -> Vec<Value> {
    let mut positions: Vec<Value> = Vec::new();

    for payload in position_payloads {
        let category = payload
            .get("result")
            .and_then(|r| r.get("category"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let rows = payload
            .get("result")
            .and_then(|r| r.get("list"))
            .and_then(|l| l.as_array())
            .cloned()
            .unwrap_or_default();

        for position in &rows {
            let raw_size = parse_number(position.get("size").unwrap_or(&Value::Null));
            if raw_size == 0.0 {
                continue;
            }

            let symbol = position
                .get("symbol")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let parsed = parse_instrument(symbol, category);
            let side = position
                .get("side")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let size = if side == "sell" {
                -raw_size.abs()
            } else {
                raw_size.abs()
            };
            let mark_price = parse_number(position.get("markPrice").unwrap_or(&Value::Null));
            let position_margin =
                parse_number(position.get("positionIM").unwrap_or(&Value::Null));
            let index_price =
                parse_number(position.get("indexPrice").unwrap_or(&Value::Null));
            let kind = parsed
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let reference_price = if index_price != 0.0 {
                index_price
            } else if kind == "option" {
                0.0
            } else {
                mark_price
            };

            let unrealized_pnl =
                parse_number(position.get("unrealisedPnl").unwrap_or(&Value::Null));
            let unrealized_pnl_ratio = if position_margin != 0.0 {
                unrealized_pnl / position_margin
            } else {
                0.0
            };

            let trade_mode = position
                .get("tradeMode")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let margin_mode = if trade_mode == 1 { "isolated" } else { "cross" };

            let notional_usd = if kind == "option" {
                0.0
            } else {
                size.abs() * mark_price
            };

            positions.push(json!({
                "instrument": symbol,
                "instrumentType": category.to_uppercase(),
                "coin": parsed["coin"],
                "kind": parsed["kind"],
                "optionType": parsed["optionType"],
                "expiry": parsed["expiry"],
                "strike": parsed["strike"],
                "referencePrice": reference_price,
                "marginMode": margin_mode,
                "size": size,
                "averagePrice": parse_number(position.get("avgPrice").unwrap_or(&Value::Null)),
                "markPrice": mark_price,
                "unrealizedPnl": unrealized_pnl,
                "unrealizedPnlRatio": unrealized_pnl_ratio,
                "delta": parse_number(position.get("delta").unwrap_or(&Value::Null)),
                "gamma": parse_number(position.get("gamma").unwrap_or(&Value::Null)),
                "theta": parse_number(position.get("theta").unwrap_or(&Value::Null)),
                "vega": parse_number(position.get("vega").unwrap_or(&Value::Null)),
                "notionalUsd": notional_usd,
            }));
        }
    }

    positions.sort_by(|a, b| {
        let av = a
            .get("notionalUsd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .abs();
        let bv = b
            .get("notionalUsd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .abs();
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
    positions
}

fn aggregate_greeks(positions: &[Value]) -> Value {
    let mut total_delta = 0.0f64;
    let mut total_gamma = 0.0f64;
    let mut total_theta = 0.0f64;
    let mut total_vega = 0.0f64;
    let mut by_coin: std::collections::HashMap<String, [f64; 4]> =
        std::collections::HashMap::new();

    for pos in positions {
        let delta = pos.get("delta").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let gamma = pos.get("gamma").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let theta = pos.get("theta").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let vega = pos.get("vega").and_then(|v| v.as_f64()).unwrap_or(0.0);
        total_delta += delta;
        total_gamma += gamma;
        total_theta += theta;
        total_vega += vega;

        if let Some(coin) = pos.get("coin").and_then(|v| v.as_str()) {
            if !coin.is_empty() {
                let entry = by_coin.entry(coin.to_string()).or_insert([0.0; 4]);
                entry[0] += delta;
                entry[1] += gamma;
                entry[2] += theta;
                entry[3] += vega;
            }
        }
    }

    let by_coin_json: serde_json::Map<String, Value> = by_coin
        .into_iter()
        .map(|(k, v)| {
            (
                k,
                json!({
                    "delta": v[0],
                    "gamma": v[1],
                    "theta": v[2],
                    "vega": v[3],
                }),
            )
        })
        .collect();

    json!({
        "total": {
            "delta": total_delta,
            "gamma": total_gamma,
            "theta": total_theta,
            "vega": total_vega,
        },
        "byCoin": Value::Object(by_coin_json),
    })
}

fn make_timestamp_ms() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.to_string()
}

fn make_iso_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    crate::optional::okx_portfolio::format_iso8601_pub(millis as i64 / 1000, (millis % 1000) as u32)
}

fn build_signature(secret_key: &str, api_key: &str, timestamp: &str, query_string: &str) -> String {
    let message = format!("{}{}{}{}", timestamp, api_key, RECV_WINDOW, query_string);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret_key.as_bytes())
        .expect("HMAC accepts any key size");
    mac.update(message.as_bytes());
    let result = mac.finalize().into_bytes();
    hex::encode(result)
}

fn encode_query(params: &[(&str, &str)]) -> String {
    params
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&")
}

async fn bybit_get(
    client: &reqwest::Client,
    path: &str,
    params: &[(&str, &str)],
    api_key: &str,
    secret_key: &str,
) -> Result<Value, String> {
    let time = make_timestamp_ms();
    let query_string = encode_query(params);
    let url = if query_string.is_empty() {
        format!("{}{}", BYBIT_BASE_URL, path)
    } else {
        format!("{}{}?{}", BYBIT_BASE_URL, path, query_string)
    };
    let sign = build_signature(secret_key, api_key, &time, &query_string);

    let response = client
        .get(&url)
        .header("Content-Type", "application/json")
        .header("X-BAPI-API-KEY", api_key)
        .header("X-BAPI-TIMESTAMP", &time)
        .header("X-BAPI-RECV-WINDOW", RECV_WINDOW)
        .header("X-BAPI-SIGN", &sign)
        .send()
        .await
        .map_err(|e| format!("Bybit request error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Bybit request failed with HTTP {}",
            response.status()
        ));
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|e| format!("Bybit JSON parse error: {}", e))?;

    let ret_code = payload.get("retCode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if ret_code != 0 {
        let msg = payload
            .get("retMsg")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("Bybit request failed with code {}: {}", ret_code, msg));
    }

    Ok(payload)
}

pub async fn handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let api_key = std::env::var("BYBIT_API_KEY").unwrap_or_default();
    let secret_key = std::env::var("BYBIT_API_SECRET").unwrap_or_default();

    if api_key.is_empty() || secret_key.is_empty() {
        return Json(json!({ "error": "Missing Bybit credentials" }));
    }

    let client = &state.http_client;

    let (account_res, balance_res, option_pos_res, linear_usdt_res, linear_usdc_res, inverse_res) = tokio::join!(
        bybit_get(client, "/v5/account/info", &[], &api_key, &secret_key),
        bybit_get(client, "/v5/account/wallet-balance", &[("accountType", "UNIFIED")], &api_key, &secret_key),
        bybit_get(client, "/v5/position/list", &[("category", "option")], &api_key, &secret_key),
        bybit_get(client, "/v5/position/list", &[("category", "linear"), ("settleCoin", "USDT")], &api_key, &secret_key),
        bybit_get(client, "/v5/position/list", &[("category", "linear"), ("settleCoin", "USDC")], &api_key, &secret_key),
        bybit_get(client, "/v5/position/list", &[("category", "inverse")], &api_key, &secret_key),
    );

    let account_payload = match account_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let balance_payload = match balance_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let option_positions = match option_pos_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let linear_usdt = match linear_usdt_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let linear_usdc = match linear_usdc_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let inverse = match inverse_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };

    let account = account_payload
        .get("result")
        .cloned()
        .unwrap_or(Value::Null);
    let wallet = balance_payload
        .get("result")
        .and_then(|r| r.get("list"))
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);

    let balances = normalize_balances(&balance_payload);
    let position_payloads = vec![option_positions, linear_usdt, linear_usdc, inverse];
    let positions = normalize_positions(&position_payloads);
    let greeks = aggregate_greeks(&positions);
    let now = make_iso_timestamp();

    let _margin_mode = account
        .get("marginMode")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let avail_bal_raw = parse_number(wallet.get("totalAvailableBalance").unwrap_or(&Value::Null));
    let available_equity_usd: Value = if avail_bal_raw == 0.0 { Value::Null } else { json!(avail_bal_raw) };

    let result = json!({
        "exchange": "bybit",
        "account": {
            "label": "Bybit Unified",
            "permission": "read_only",
            "positionMode": "merged_single",
            "greeksType": "BS",
            "settleCurrency": "USD",
        },
        "summary": {
            "totalEquityUsd": parse_number(wallet.get("totalEquity").unwrap_or(&Value::Null)),
            "availableEquityUsd": available_equity_usd,
            "openPositions": positions.len(),
            "derivativesCount": positions.len(),
            "balancesCount": balances.len(),
            "updatedAt": now,
        },
        "balances": balances,
        "greeks": greeks,
        "positions": positions,
    });

    Json(result)
}
