use axum::{extract::State, response::IntoResponse, Json};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;

use crate::state::AppState;

const OKX_BASE_URL: &str = "https://www.okx.com";

fn env_first(keys: &[&str]) -> String {
    for key in keys {
        let value = std::env::var(key).unwrap_or_default();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn parse_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn first_row(payload: &Value) -> &Value {
    payload
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .unwrap_or(&Value::Null)
}

fn parse_instrument(inst_id: &str, inst_type: &str) -> Value {
    let parts: Vec<&str> = inst_id.split('-').collect();
    let coin = parts.first().copied().unwrap_or("").to_string();
    let kind = inst_type.to_uppercase();

    if kind == "OPTION" && parts.len() >= 5 {
        let raw_expiry = parts[2];
        let expiry = if raw_expiry.len() >= 6 {
            format!(
                "20{}-{}-{}",
                &raw_expiry[0..2],
                &raw_expiry[2..4],
                &raw_expiry[4..6]
            )
        } else {
            raw_expiry.to_string()
        };
        let option_type = if parts[4] == "C" { "call" } else { "put" };
        let strike: Option<f64> = parts.get(3).and_then(|s| s.parse().ok());
        return json!({
            "coin": coin,
            "kind": "option",
            "optionType": option_type,
            "expiry": expiry,
            "strike": strike,
        });
    }

    if kind == "SWAP" {
        return json!({
            "coin": coin,
            "kind": "swap",
            "optionType": null,
            "expiry": "perpetual",
            "strike": null,
        });
    }

    if kind == "FUTURES" && parts.len() >= 3 {
        let raw_expiry = parts[2];
        let expiry = if raw_expiry.len() >= 6 {
            format!(
                "20{}-{}-{}",
                &raw_expiry[0..2],
                &raw_expiry[2..4],
                &raw_expiry[4..6]
            )
        } else {
            raw_expiry.to_string()
        };
        return json!({
            "coin": coin,
            "kind": "future",
            "optionType": null,
            "expiry": expiry,
            "strike": null,
        });
    }

    json!({
        "coin": coin,
        "kind": "other",
        "optionType": null,
        "expiry": null,
        "strike": null,
    })
}

fn sign_request(secret_key: &str, timestamp: &str, method: &str, path: &str, body: &str) -> String {
    let message = format!("{}{}{}{}", timestamp, method, path, body);
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret_key.as_bytes()).expect("HMAC accepts any key size");
    mac.update(message.as_bytes());
    let result = mac.finalize().into_bytes();
    base64::engine::general_purpose::STANDARD.encode(result)
}

fn make_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Format as ISO 8601
    let secs = (millis / 1000) as i64;
    let ms = (millis % 1000) as u32;
    // Use a simple manual formatter: seconds since epoch → ISO 8601
    // We'll use the chrono-style approach via formatting
    format_iso8601(secs, ms)
}

pub fn format_iso8601_pub(unix_secs: i64, millis: u32) -> String {
    format_iso8601(unix_secs, millis)
}

fn format_iso8601(unix_secs: i64, millis: u32) -> String {
    // Simple implementation without chrono
    let s = unix_secs as u64;
    let mut remaining = s;

    // Days since epoch
    let days = remaining / 86400;
    remaining %= 86400;
    let hours = remaining / 3600;
    remaining %= 3600;
    let minutes = remaining / 60;
    let secs = remaining % 60;

    // Date from days
    let (year, month, day) = days_to_date(days as u32);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, minutes, secs, millis
    )
}

fn days_to_date(days: u32) -> (u32, u32, u32) {
    // Days since 1970-01-01
    let mut year = 1970u32;
    let mut d = days;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        year += 1;
    }
    let month_days: &[u32] = if is_leap(year) {
        &[31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        &[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1u32;
    for &md in month_days {
        if d < md {
            break;
        }
        d -= md;
        month += 1;
    }
    (year, month, d + 1)
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn normalize_balances(balance_payload: &Value) -> Vec<Value> {
    let first = first_row(balance_payload);
    let details = first
        .get("details")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let mut balances: Vec<Value> = details
        .iter()
        .map(|detail| {
            let currency = detail
                .get("ccy")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            json!({
                "currency": currency,
                "equity": parse_number(detail.get("eq").unwrap_or(&Value::Null)),
                "usdValue": parse_number(detail.get("eqUsd").unwrap_or(&Value::Null)),
                "available": parse_number(detail.get("availBal").unwrap_or(&Value::Null)),
                "frozen": parse_number(detail.get("frozenBal").unwrap_or(&Value::Null)),
                "upl": parse_number(detail.get("upl").unwrap_or(&Value::Null)),
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

fn normalize_positions(positions_payload: &Value) -> Vec<Value> {
    let rows = positions_payload
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let mut positions: Vec<Value> = rows
        .iter()
        .filter(|pos| {
            let p = pos.get("pos").unwrap_or(&Value::Null);
            parse_number(p) != 0.0
        })
        .map(|pos| {
            let inst_id = pos.get("instId").and_then(|v| v.as_str()).unwrap_or("");
            let inst_type = pos.get("instType").and_then(|v| v.as_str()).unwrap_or("");
            let parsed = parse_instrument(inst_id, inst_type);

            json!({
                "instrument": inst_id,
                "instrumentType": inst_type,
                "coin": parsed["coin"],
                "kind": parsed["kind"],
                "optionType": parsed["optionType"],
                "expiry": parsed["expiry"],
                "strike": parsed["strike"],
                "referencePrice": parse_number(pos.get("idxPx").unwrap_or(&Value::Null)),
                "marginMode": pos.get("mgnMode").and_then(|v| v.as_str()).unwrap_or(""),
                "size": parse_number(pos.get("pos").unwrap_or(&Value::Null)),
                "averagePrice": parse_number(pos.get("avgPx").unwrap_or(&Value::Null)),
                "markPrice": parse_number(pos.get("markPx").unwrap_or(&Value::Null)),
                "unrealizedPnl": parse_number(pos.get("upl").unwrap_or(&Value::Null)),
                "unrealizedPnlRatio": parse_number(pos.get("uplRatio").unwrap_or(&Value::Null)),
                "delta": parse_number(pos.get("deltaBS").unwrap_or(&Value::Null)),
                "gamma": parse_number(pos.get("gammaBS").unwrap_or(&Value::Null)),
                "theta": parse_number(pos.get("thetaBS").unwrap_or(&Value::Null)),
                "vega": parse_number(pos.get("vegaBS").unwrap_or(&Value::Null)),
                "notionalUsd": parse_number(pos.get("notionalUsd").unwrap_or(&Value::Null)),
            })
        })
        .collect();

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
    let mut by_coin: std::collections::HashMap<String, [f64; 4]> = std::collections::HashMap::new();

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

async fn okx_get(
    client: &reqwest::Client,
    path: &str,
    api_key: &str,
    secret_key: &str,
    passphrase: &str,
    demo_trading: bool,
) -> Result<Value, String> {
    let timestamp = make_timestamp();
    let sign = sign_request(secret_key, &timestamp, "GET", path, "");

    let mut req = client
        .get(format!("{}{}", OKX_BASE_URL, path))
        .header("Content-Type", "application/json")
        .header("OK-ACCESS-KEY", api_key)
        .header("OK-ACCESS-SIGN", &sign)
        .header("OK-ACCESS-TIMESTAMP", &timestamp)
        .header("OK-ACCESS-PASSPHRASE", passphrase);

    if demo_trading {
        req = req.header("x-simulated-trading", "1");
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("OKX request error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "OKX request failed with HTTP {}",
            response.status()
        ));
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|e| format!("OKX JSON parse error: {}", e))?;

    if payload.get("code").and_then(|v| v.as_str()) != Some("0") {
        let msg = payload
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let code = payload
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("OKX request failed with code {}: {}", code, msg));
    }

    Ok(payload)
}

pub async fn handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let api_key = env_first(&["OKX_API_KEY", "apikey"]);
    let secret_key = env_first(&["OKX_API_SECRET", "OKX_SECRET_KEY", "secretkey"]);
    let passphrase = env_first(&["OKX_PASSPHRASE", "passphrase"]);
    let demo_trading = std::env::var("OKX_DEMO_TRADING")
        .map(|v| v.to_lowercase() == "true")
        .unwrap_or(false);

    if api_key.is_empty() || secret_key.is_empty() || passphrase.is_empty() {
        return Json(json!({ "error": "Missing OKX credentials" }));
    }

    let client = &state.http_client;

    let (config_res, balance_res, positions_res) = tokio::join!(
        okx_get(
            client,
            "/api/v5/account/config",
            &api_key,
            &secret_key,
            &passphrase,
            demo_trading
        ),
        okx_get(
            client,
            "/api/v5/account/balance",
            &api_key,
            &secret_key,
            &passphrase,
            demo_trading
        ),
        okx_get(
            client,
            "/api/v5/account/positions",
            &api_key,
            &secret_key,
            &passphrase,
            demo_trading
        ),
    );

    let config_payload = match config_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let balance_payload = match balance_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };
    let positions_payload = match positions_res {
        Ok(v) => v,
        Err(e) => return Json(json!({ "error": e })),
    };

    let config = first_row(&config_payload);
    let balance = first_row(&balance_payload);
    let balances = normalize_balances(&balance_payload);
    let positions = normalize_positions(&positions_payload);
    let greeks = aggregate_greeks(&positions);
    let now = make_timestamp();

    let avail_eq_raw = parse_number(balance.get("availEq").unwrap_or(&Value::Null));
    let available_equity_usd: Value = if avail_eq_raw == 0.0 {
        Value::Null
    } else {
        json!(avail_eq_raw)
    };

    let result = json!({
        "exchange": "okx",
        "account": {
            "label": config.get("label").and_then(|v| v.as_str()).unwrap_or(""),
            "permission": config.get("perm").and_then(|v| v.as_str()).unwrap_or(""),
            "positionMode": config.get("posMode").and_then(|v| v.as_str()).unwrap_or(""),
            "greeksType": config.get("greeksType").and_then(|v| v.as_str()).unwrap_or(""),
            "settleCurrency": config.get("settleCcy").and_then(|v| v.as_str()).unwrap_or(""),
        },
        "summary": {
            "totalEquityUsd": parse_number(balance.get("totalEq").unwrap_or(&Value::Null)),
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

#[cfg(test)]
mod tests {
    use super::env_first;

    #[test]
    fn env_first_reads_legacy_okx_aliases() {
        std::env::remove_var("OKX_API_KEY");
        std::env::set_var("apikey", "legacy-key");

        assert_eq!(env_first(&["OKX_API_KEY", "apikey"]), "legacy-key");

        std::env::remove_var("apikey");
    }
}
