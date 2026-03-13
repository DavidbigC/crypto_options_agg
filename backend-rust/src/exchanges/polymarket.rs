use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::RwLock;

const GAMMA_BASE: &str = "https://gamma-api.polymarket.com";
const CLOB_BASE:  &str = "https://clob.polymarket.com";
const DATA_BASE:  &str = "https://data-api.polymarket.com";
const WS_URL:     &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const USER_AGENT: &str = "polysis/1.0";
const DISCOVERY_TTL: Duration = Duration::from_secs(5 * 60);
const METADATA_TTL:  Duration = Duration::from_secs(5 * 60);
const RECONNECT_BASE_MS: u64 = 2_000;
const RECONNECT_MAX_MS:  u64 = 60_000;

pub type PriceCache     = Arc<RwLock<HashMap<String, f64>>>;
pub type DiscoveryCache = Arc<RwLock<HashMap<String, (Vec<Value>, Instant)>>>;
pub type OiCache        = Arc<RwLock<HashMap<String, (f64, Instant)>>>;
pub type TokenAssetMap  = Arc<RwLock<HashMap<String, Vec<String>>>>;

// ─── HTTP ────────────────────────────────────────────────────────────────────

async fn get_json(client: &reqwest::Client, url: &str) -> anyhow::Result<Value> {
    let resp = client.get(url).header("User-Agent", USER_AGENT).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {} for {}", resp.status(), url);
    }
    Ok(resp.json().await?)
}

async fn search_gamma(client: &reqwest::Client, q: &str, limit: u32) -> anyhow::Result<Value> {
    let url = format!("{}/public-search", GAMMA_BASE);
    let resp = client.get(&url)
        .header("User-Agent", USER_AGENT)
        .query(&[("q", q), ("limit_per_type", &limit.to_string())])
        .send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("Gamma search HTTP {}", resp.status());
    }
    let payload: Value = resp.json().await?;
    if !payload.get("events").map(|e| e.is_array()).unwrap_or(false) {
        anyhow::bail!("Expected events array in Gamma response");
    }
    Ok(payload)
}

async fn get_clob_prices(client: &reqwest::Client, token_ids: &[String]) -> anyhow::Result<Value> {
    if token_ids.is_empty() { return Ok(json!({})); }
    let url = format!("{}/prices", CLOB_BASE);
    let resp = client.get(&url)
        .header("User-Agent", USER_AGENT)
        .query(&[("token_ids", token_ids.join(","))])
        .send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("CLOB prices HTTP {}", resp.status());
    }
    Ok(resp.json().await?)
}

async fn get_open_interest_value(client: &reqwest::Client, market_id: &str) -> f64 {
    let url = format!("{}/oi?market={}", DATA_BASE, market_id);
    let arr = match get_json(client, &url).await {
        Ok(v) => v,
        Err(_) => return 0.0,
    };
    let first = match arr.as_array().and_then(|a| a.first()) {
        Some(v) => v,
        None => return 0.0,
    };
    first["value"].as_f64()
        .or_else(|| first["open_interest"].as_f64())
        .or_else(|| first["openInterest"].as_f64())
        .unwrap_or(0.0)
}

// ─── Normalization ───────────────────────────────────────────────────────────

fn parse_dollar_number(raw: &str) -> Option<f64> {
    if raw.is_empty() { return None; }
    let s = raw.replace(['$', ',', ' '], "");
    let (s, mult) = if s.to_ascii_lowercase().ends_with('k') {
        (&s[..s.len()-1], 1000.0)
    } else {
        (s.as_str(), 1.0)
    };
    s.parse::<f64>().ok().map(|n| n * mult)
}

// Compiled regexes (lazy)
static RE_RANGE:     Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\$?\s*([\d,.]+k?)\s*-\s*\$?\s*([\d,.]+k?)").unwrap());
static RE_WHERE:     Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:where will|close)\b").unwrap());
static RE_DIP:       Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:dip(?:\s+to)?|drop(?:\s+to)?|fall(?:\s+to)?)\s+\$?\s*([\d,.]+k?)").unwrap());
static RE_PATH:      Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:hit|touch|reach)\s+\$?\s*([\d,.]+k?)").unwrap());
static RE_THRESHOLD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:above|over|below|under)\s+\$?\s*([\d,.]+k?)").unwrap());
static RE_ABOVE:     Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:above|over)\b").unwrap());
static RE_BTC:       Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:btc|bitcoin)\b").unwrap());
static RE_ETH:       Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:eth|ethereum)\b").unwrap());
static RE_SOL:       Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:sol|solana)\b").unwrap());
static RE_DAILY:     Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:today|daily|tomorrow)\b").unwrap());
static RE_WEEKLY:    Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:this week|weekly|week)\b").unwrap());
static RE_MONTHLY:   Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:this month|monthly|month)\b").unwrap());
static RE_YEARLY:    Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(?:this year|yearly|year)\b").unwrap());

fn extract_asset(text: &str) -> Option<&'static str> {
    if RE_BTC.is_match(text) { return Some("BTC"); }
    if RE_ETH.is_match(text) { return Some("ETH"); }
    if RE_SOL.is_match(text) { return Some("SOL"); }
    None
}

fn extract_horizon(text: &str) -> Option<&'static str> {
    if RE_DAILY.is_match(text)   { return Some("daily"); }
    if RE_WEEKLY.is_match(text)  { return Some("weekly"); }
    if RE_MONTHLY.is_match(text) { return Some("monthly"); }
    if RE_YEARLY.is_match(text)  { return Some("yearly"); }
    None
}

fn classify_market(market: &Value) -> Value {
    let question = market["question"].as_str()
        .or_else(|| market["title"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if question.is_empty() {
        return json!({"type": "unknown", "confidence": "low", "reason": "Missing market question"});
    }

    if let Some(caps) = RE_RANGE.captures(&question) {
        if RE_WHERE.is_match(&question) {
            if let (Some(low), Some(high)) = (parse_dollar_number(&caps[1]), parse_dollar_number(&caps[2])) {
                if high > low {
                    return json!({"type": "range", "range": {"low": low, "high": high}, "confidence": "high"});
                }
            }
        }
    }
    if let Some(caps) = RE_DIP.captures(&question) {
        if let Some(barrier) = parse_dollar_number(&caps[1]) {
            return json!({"type": "path", "direction": "below", "barrier": barrier, "confidence": "high"});
        }
    }
    if let Some(caps) = RE_PATH.captures(&question) {
        if let Some(barrier) = parse_dollar_number(&caps[1]) {
            return json!({"type": "path", "direction": "above", "barrier": barrier, "confidence": "high"});
        }
    }
    if let Some(caps) = RE_THRESHOLD.captures(&question) {
        if let Some(strike) = parse_dollar_number(&caps[1]) {
            let direction = if RE_ABOVE.is_match(&question) { "above" } else { "below" };
            return json!({"type": "threshold", "direction": direction, "strike": strike, "confidence": "high"});
        }
    }
    json!({"type": "unknown", "confidence": "low", "reason": "Ambiguous market title"})
}

fn clamp_prob(v: f64) -> f64 {
    if !v.is_finite() { return 0.0; }
    v.clamp(0.0, 1.0)
}

fn round_prob(v: f64) -> f64 {
    (clamp_prob(v) * 1e6).round() / 1e6
}

fn build_distribution(markets: &[Value]) -> Value {
    let classified: Vec<Value> = markets.iter().map(|m| {
        let cls = classify_market(m);
        let prob = clamp_prob(m["lastTradePrice"].as_f64().unwrap_or(0.0));
        let mut c = cls.clone();
        c["probability"] = json!(prob);
        c
    }).collect();

    let mut range_markets: Vec<&Value> = classified.iter().filter(|c| c["type"] == "range").collect();
    if !range_markets.is_empty() {
        range_markets.sort_by(|a, b| {
            let la = a["range"]["low"].as_f64().unwrap_or(0.0);
            let lb = b["range"]["low"].as_f64().unwrap_or(0.0);
            la.partial_cmp(&lb).unwrap()
        });
        let bins: Vec<Value> = range_markets.iter().map(|m| json!({
            "low": m["range"]["low"],
            "high": m["range"]["high"],
            "probability": m["probability"],
        })).collect();
        let excluded = classified.iter().filter(|c| c["type"] == "path").count();
        return json!({"source": "range", "bins": bins, "excludedPathMarkets": excluded});
    }

    let mut threshold_markets: Vec<&Value> = classified.iter()
        .filter(|c| c["type"] == "threshold" && c["direction"] == "above")
        .collect();
    if threshold_markets.len() >= 2 {
        threshold_markets.sort_by(|a, b| {
            let sa = a["strike"].as_f64().unwrap_or(0.0);
            let sb = b["strike"].as_f64().unwrap_or(0.0);
            sa.partial_cmp(&sb).unwrap()
        });
        let mut bins = Vec::new();
        for i in 0..threshold_markets.len() {
            let curr = &threshold_markets[i];
            let next_prob = threshold_markets.get(i + 1)
                .and_then(|n| n["probability"].as_f64())
                .unwrap_or(0.0);
            let prob = round_prob(curr["probability"].as_f64().unwrap_or(0.0) - next_prob);
            if prob > 0.0 {
                bins.push(json!({
                    "low": curr["strike"],
                    "high": threshold_markets.get(i + 1).map(|n| n["strike"].clone()).unwrap_or(Value::Null),
                    "probability": prob,
                }));
            }
        }
        let excluded = classified.iter().filter(|c| c["type"] == "path").count();
        return json!({"source": "threshold", "bins": bins, "excludedPathMarkets": excluded});
    }

    let excluded = classified.iter().filter(|c| c["type"] == "path").count();
    json!({"source": "none", "bins": [], "excludedPathMarkets": excluded})
}

fn summarize_distribution(distribution: &Value, spot: f64) -> Value {
    let bins = match distribution["bins"].as_array() {
        Some(b) if !b.is_empty() && spot > 0.0 => b,
        _ => return json!({"expectedPrice": null, "expectedMove": null, "expectedMovePct": null, "mostLikelyRange": null}),
    };

    let expected_price: f64 = bins.iter().map(|bin| {
        let mid = if bin["high"].is_null() {
            bin["low"].as_f64().unwrap_or(0.0)
        } else {
            (bin["low"].as_f64().unwrap_or(0.0) + bin["high"].as_f64().unwrap_or(0.0)) / 2.0
        };
        mid * bin["probability"].as_f64().unwrap_or(0.0)
    }).sum();

    let most_likely = bins.iter().max_by(|a, b| {
        a["probability"].as_f64().unwrap_or(0.0)
            .partial_cmp(&b["probability"].as_f64().unwrap_or(0.0)).unwrap()
    });

    let expected_move = (expected_price - spot).abs();
    let expected_move_pct = (expected_move / spot * 100.0 * 100.0).round() / 100.0;

    json!({
        "expectedPrice": expected_price.round() as i64,
        "expectedMove": expected_move.round() as i64,
        "expectedMovePct": expected_move_pct,
        "mostLikelyRange": most_likely,
    })
}

fn summarize_path_markets(markets: &[Value], spot: f64) -> Value {
    let empty = json!({"pathMovePct": null, "pathMoveUsd": null, "upsidePathPct": null, "downsidePathPct": null, "strongestUpsideBarrier": null, "strongestDownsideBarrier": null});
    if !spot.is_finite() || spot <= 0.0 { return empty; }

    let classified: Vec<Value> = markets.iter()
        .map(|m| {
            let cls = classify_market(m);
            let prob = clamp_prob(m["lastTradePrice"].as_f64().unwrap_or(0.0));
            let mut c = cls;
            c["probability"] = json!(prob);
            c
        })
        .filter(|c| c["type"] == "path" && c["barrier"].as_f64().is_some())
        .collect();

    if classified.is_empty() { return empty; }

    let mut upside_pct = 0.0f64;
    let mut downside_pct = 0.0f64;
    let mut strongest_up_barrier: Option<f64> = None;
    let mut strongest_down_barrier: Option<f64> = None;
    let mut strongest_up_prob = -1.0f64;
    let mut strongest_down_prob = -1.0f64;

    let mut upside: Vec<&Value> = classified.iter()
        .filter(|c| c["barrier"].as_f64().unwrap_or(0.0) > spot && c["direction"] != "below")
        .collect();
    upside.sort_by(|a, b| a["barrier"].as_f64().unwrap_or(0.0).partial_cmp(&b["barrier"].as_f64().unwrap_or(0.0)).unwrap());

    for (i, m) in upside.iter().enumerate() {
        let next_prob = upside.get(i + 1).and_then(|n| n["probability"].as_f64()).unwrap_or(0.0);
        let marginal = (clamp_prob(m["probability"].as_f64().unwrap_or(0.0)) - next_prob).max(0.0);
        let barrier = m["barrier"].as_f64().unwrap_or(0.0);
        upside_pct += marginal * ((barrier / spot) - 1.0) * 100.0;
        let prob = clamp_prob(m["probability"].as_f64().unwrap_or(0.0));
        if prob > strongest_up_prob {
            strongest_up_prob = prob;
            strongest_up_barrier = Some(barrier);
        }
    }

    let mut downside: Vec<&Value> = classified.iter()
        .filter(|c| c["barrier"].as_f64().unwrap_or(0.0) < spot && c["direction"] == "below")
        .collect();
    downside.sort_by(|a, b| b["barrier"].as_f64().unwrap_or(0.0).partial_cmp(&a["barrier"].as_f64().unwrap_or(0.0)).unwrap());

    for (i, m) in downside.iter().enumerate() {
        let next_prob = downside.get(i + 1).and_then(|n| n["probability"].as_f64()).unwrap_or(0.0);
        let marginal = (clamp_prob(m["probability"].as_f64().unwrap_or(0.0)) - next_prob).max(0.0);
        let barrier = m["barrier"].as_f64().unwrap_or(0.0);
        downside_pct += marginal * (1.0 - (barrier / spot)) * 100.0;
        let prob = clamp_prob(m["probability"].as_f64().unwrap_or(0.0));
        if prob > strongest_down_prob {
            strongest_down_prob = prob;
            strongest_down_barrier = Some(barrier);
        }
    }

    let path_move_pct = (upside_pct + downside_pct) / 2.0;
    let path_move_pct_r = (path_move_pct * 100.0).round() / 100.0;
    let upside_pct_r = (upside_pct * 100.0).round() / 100.0;
    let downside_pct_r = (downside_pct * 100.0).round() / 100.0;

    json!({
        "pathMovePct": path_move_pct_r,
        "pathMoveUsd": (path_move_pct / 100.0 * spot).round() as i64,
        "upsidePathPct": upside_pct_r,
        "downsidePathPct": downside_pct_r,
        "strongestUpsideBarrier": strongest_up_barrier,
        "strongestDownsideBarrier": strongest_down_barrier,
    })
}

// ─── Market Discovery ────────────────────────────────────────────────────────

fn format_month_day(ts_ms: i64) -> String {
    let secs = ts_ms / 1000;
    let days_since_epoch = secs / 86400;
    // Hinnant civil date algorithm
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2) / 153;
    let d = doy - (153*mp + 2)/5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let month_name = match m {
        1 => "january", 2 => "february", 3 => "march", 4 => "april",
        5 => "may", 6 => "june", 7 => "july", 8 => "august",
        9 => "september", 10 => "october", 11 => "november", 12 => "december",
        _ => "unknown",
    };
    format!("{} {}", month_name, d)
}

fn build_search_query(asset: &str, horizon: &str, now_ms: i64) -> String {
    let asset_query = match asset {
        "BTC" => "bitcoin",
        "ETH" => "ethereum",
        "SOL" => "solana",
        _ => asset,
    };
    if horizon == "daily" {
        format!("{} on {}", asset_query, format_month_day(now_ms))
    } else {
        format!("{} {}", asset_query, horizon)
    }
}

fn infer_asset_from_event(event: &Value, market: &Value) -> Option<&'static str> {
    let tag_slugs: Vec<String> = event["tags"].as_array().unwrap_or(&vec![])
        .iter()
        .filter_map(|t| t["slug"].as_str().map(|s| s.to_lowercase()))
        .collect();

    if tag_slugs.iter().any(|s| s == "bitcoin") { return Some("BTC"); }
    if tag_slugs.iter().any(|s| s == "ethereum") { return Some("ETH"); }
    if tag_slugs.iter().any(|s| s == "solana") { return Some("SOL"); }

    let texts = [
        event["slug"].as_str().unwrap_or(""),
        event["title"].as_str().unwrap_or(""),
        market["slug"].as_str().unwrap_or(""),
        market["question"].as_str().unwrap_or(""),
    ];
    for text in &texts {
        if RE_BTC.is_match(text) { return Some("BTC"); }
        if RE_ETH.is_match(text) { return Some("ETH"); }
        if RE_SOL.is_match(text) { return Some("SOL"); }
    }

    let combined = format!("{} {}", event["title"].as_str().unwrap_or(""), market["question"].as_str().unwrap_or(""));
    extract_asset(&combined)
}

fn infer_horizon_from_event(event: &Value, market: &Value) -> Option<&'static str> {
    let tag_slugs: Vec<String> = event["tags"].as_array().unwrap_or(&vec![])
        .iter()
        .filter_map(|t| t["slug"].as_str().map(|s| s.to_lowercase()))
        .collect();
    if tag_slugs.iter().any(|s| s == "daily")   { return Some("daily"); }
    if tag_slugs.iter().any(|s| s == "weekly")  { return Some("weekly"); }
    if tag_slugs.iter().any(|s| s == "monthly") { return Some("monthly"); }
    if tag_slugs.iter().any(|s| s == "yearly")  { return Some("yearly"); }

    let series_slug = event["seriesSlug"].as_str()
        .or_else(|| event["slug"].as_str())
        .unwrap_or("");
    if series_slug.to_ascii_lowercase().contains("daily")   { return Some("daily"); }
    if series_slug.to_ascii_lowercase().contains("weekly")  { return Some("weekly"); }
    if series_slug.to_ascii_lowercase().contains("monthly") { return Some("monthly"); }
    if series_slug.to_ascii_lowercase().contains("yearly")  { return Some("yearly"); }

    let combined = format!("{} {}", event["title"].as_str().unwrap_or(""), market["question"].as_str().unwrap_or(""));
    extract_horizon(&combined)
}

fn is_open_market(market: &Value) -> bool {
    market["active"].as_bool().unwrap_or(true)
        && !market["closed"].as_bool().unwrap_or(false)
        && market["event"]["active"].as_bool().unwrap_or(true)
        && !market["event"]["closed"].as_bool().unwrap_or(false)
}

fn event_end_time(market: &Value) -> f64 {
    let raw = market["event"]["endDate"].as_str()
        .or_else(|| market["endDate"].as_str());
    raw.and_then(chrono_free_parse_date).unwrap_or(f64::INFINITY)
}

fn chrono_free_parse_date(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.splitn(2, 'T').collect();
    let date_part = parts[0];
    let date_fields: Vec<&str> = date_part.split('-').collect();
    if date_fields.len() < 3 { return None; }
    let year: i64 = date_fields[0].parse().ok()?;
    let month: i64 = date_fields[1].parse().ok()?;
    let day: i64 = date_fields[2].parse().ok()?;
    // Hinnant: days since epoch
    let m = if month <= 2 { month + 9 } else { month - 3 };
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some((days * 86400 * 1000) as f64)
}

fn resolve_token_ids(market: &Value) -> Vec<String> {
    if let Some(arr) = market["clobTokenIds"].as_array() {
        let ids: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() { return ids; }
    }
    if let Some(s) = market["clobTokenIds"].as_str() {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(s) {
            let ids: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).filter(|s| !s.is_empty()).collect();
            if !ids.is_empty() { return ids; }
        }
    }
    if let Some(id) = market["clobTokenId"].as_str() {
        if !id.is_empty() { return vec![id.to_string()]; }
    }
    vec![]
}

fn parse_outcome_probability(market: &Value) -> Option<f64> {
    if let Some(arr) = market["outcomePrices"].as_array() {
        if let Some(first) = arr.first() {
            let v = first.as_f64().or_else(|| first.as_str().and_then(|s| s.parse().ok()))?;
            if v.is_finite() { return Some(v); }
        }
    }
    if let Some(s) = market["outcomePrices"].as_str() {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(s) {
            if let Some(first) = arr.first() {
                let v = first.as_f64().or_else(|| first.as_str().and_then(|s| s.parse().ok()))?;
                if v.is_finite() { return Some(v); }
            }
        }
    }
    None
}

fn resolve_live_price(token_ids: &[String], reference_prob: Option<f64>, prices: &HashMap<String, f64>) -> Option<f64> {
    let raw_prices: Vec<f64> = token_ids.iter()
        .filter_map(|id| prices.get(id).copied())
        .filter(|p| p.is_finite())
        .collect();
    if raw_prices.is_empty() { return None; }

    let candidates: Vec<f64> = raw_prices.iter().flat_map(|&p| {
        let comp = ((1.0 - p) * 1e6).round() / 1e6;
        vec![p, comp]
    }).collect();

    let reference = reference_prob.filter(|r| r.is_finite())?;
    candidates.iter().copied().min_by(|a, b| {
        let da = (a - reference).abs();
        let db = (b - reference).abs();
        da.partial_cmp(&db).unwrap()
    })
}

fn classify_by_score(group: &[Value]) -> i32 {
    group.iter().map(|m| {
        let t = classify_market(m)["type"].as_str().unwrap_or("unknown").to_string();
        if t == "unknown" { 0 } else { 1 }
    }).sum()
}

fn select_nearest_event_markets(markets: &[Value]) -> Vec<Value> {
    let open: Vec<&Value> = markets.iter().filter(|m| is_open_market(m)).collect();
    if open.is_empty() { return vec![]; }

    let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
    for market in &open {
        let slug = market["event"]["slug"].as_str()
            .or_else(|| market["event"]["id"].as_str())
            .or_else(|| market["slug"].as_str())
            .or_else(|| market["id"].as_str())
            .unwrap_or("")
            .to_string();
        grouped.entry(slug).or_default().push((*market).clone());
    }

    let mut groups: Vec<Vec<Value>> = grouped.into_values().collect();
    groups.sort_by(|a, b| {
        let score_b = classify_by_score(b);
        let score_a = classify_by_score(a);
        let score_cmp = score_b.cmp(&score_a);
        if score_cmp != std::cmp::Ordering::Equal { return score_cmp; }
        let end_a = event_end_time(a.first().unwrap_or(&Value::Null));
        let end_b = event_end_time(b.first().unwrap_or(&Value::Null));
        end_a.partial_cmp(&end_b).unwrap_or(std::cmp::Ordering::Equal)
    });

    groups.into_iter().next().unwrap_or_default()
}

// ─── Service ─────────────────────────────────────────────────────────────────

async fn get_selected_markets(
    asset: &str,
    horizon: &str,
    client: &reqwest::Client,
    discovery: &DiscoveryCache,
) -> anyhow::Result<Vec<Value>> {
    let cache_key = format!("{}:{}", asset, horizon);
    let now = Instant::now();

    {
        let cache = discovery.read().await;
        if let Some((markets, ts)) = cache.get(&cache_key) {
            if now.duration_since(*ts) < DISCOVERY_TTL {
                return Ok(markets.clone());
            }
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let search_q = build_search_query(asset, horizon, now_ms);
    let payload = search_gamma(client, &search_q, 25).await?;

    let events = payload["events"].as_array().cloned().unwrap_or_default();
    let mut discovered: Vec<Value> = events.into_iter().flat_map(|event| {
        let markets = event["markets"].as_array().cloned().unwrap_or_default();
        markets.into_iter().map(move |mut market| {
            let inferred_asset   = infer_asset_from_event(&event, &market).unwrap_or("").to_string();
            let inferred_horizon = infer_horizon_from_event(&event, &market).unwrap_or("").to_string();
            market["event"]           = event.clone();
            market["inferredAsset"]   = json!(inferred_asset);
            market["inferredHorizon"] = json!(inferred_horizon);
            market
        }).collect::<Vec<_>>()
    }).collect();

    let relevant: Vec<Value> = discovered.drain(..)
        .filter(|m| m["inferredAsset"] == asset && m["inferredHorizon"] == horizon)
        .collect();

    let selected = select_nearest_event_markets(&relevant);

    discovery.write().await.insert(cache_key, (selected.clone(), now));
    Ok(selected)
}

async fn build_source_markets(
    selected: &[Value],
    client: &reqwest::Client,
    oi_cache: &OiCache,
    prices: &PriceCache,
) -> Vec<Value> {
    let price_map = prices.read().await.clone();

    let missing_token_ids: Vec<String> = selected.iter()
        .filter(|m| {
            let token_ids = resolve_token_ids(m);
            let fallback  = parse_outcome_probability(m);
            let last_trade = m["lastTradePrice"].as_f64();
            !last_trade.filter(|v| v.is_finite()).is_some()
                && !fallback.filter(|v| v.is_finite()).is_some()
                && !token_ids.iter().any(|id| price_map.contains_key(id))
        })
        .flat_map(|m| resolve_token_ids(m))
        .collect();

    let clob_prices: HashMap<String, f64> = if !missing_token_ids.is_empty() {
        match get_clob_prices(client, &missing_token_ids).await {
            Ok(v) => v.as_object().map(|obj| {
                obj.iter().filter_map(|(k, v)| v.as_f64().map(|f| (k.clone(), f))).collect()
            }).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    } else {
        HashMap::new()
    };

    let mut results = Vec::new();
    for market in selected {
        let token_ids = resolve_token_ids(market);
        let cls       = classify_market(market);
        let fallback_prob   = parse_outcome_probability(market);
        let last_trade_gamma = market["lastTradePrice"].as_f64();

        let ws_price = {
            let reference = fallback_prob.filter(|v| v.is_finite())
                .or_else(|| last_trade_gamma.filter(|v| v.is_finite()));
            resolve_live_price(&token_ids, reference, &price_map)
        };

        let clob_price = token_ids.iter()
            .find_map(|id| clob_prices.get(id).copied().filter(|p| p.is_finite()));

        let last_trade_price = ws_price
            .or_else(|| last_trade_gamma.filter(|v| v.is_finite()))
            .or_else(|| fallback_prob.filter(|v| v.is_finite()))
            .or_else(|| clob_price)
            .unwrap_or(0.0);

        let volume_num: f64 = market["volumeNum"].as_f64()
            .or_else(|| market["volume"].as_f64())
            .unwrap_or(0.0);
        let spread_pct: f64 = market["spreadPct"].as_f64()
            .or_else(|| market["spread"].as_f64())
            .unwrap_or(0.0);

        let oi_key = market["conditionId"].as_str()
            .or_else(|| market["id"].as_str())
            .unwrap_or("")
            .to_string();
        let open_interest = get_oi(client, &oi_key, oi_cache).await;

        results.push(json!({
            "id": market["id"],
            "slug": market["slug"],
            "question": market["question"].as_str().or_else(|| market["title"].as_str()).unwrap_or(""),
            "tokenId": token_ids.first(),
            "tokenIds": token_ids,
            "endDate": market["event"]["endDate"].as_str().or_else(|| market["endDate"].as_str()),
            "lastTradePrice": last_trade_price,
            "volumeNum": volume_num,
            "openInterest": open_interest,
            "spreadPct": spread_pct,
            "classification": cls,
        }));
    }
    results
}

async fn get_oi(client: &reqwest::Client, key: &str, cache: &OiCache) -> f64 {
    if key.is_empty() { return 0.0; }
    let now = Instant::now();
    {
        let c = cache.read().await;
        if let Some((oi, ts)) = c.get(key) {
            if now.duration_since(*ts) < METADATA_TTL { return *oi; }
        }
    }
    let oi = get_open_interest_value(client, key).await;
    cache.write().await.insert(key.to_string(), (oi, now));
    oi
}

fn confidence_label(score: i64) -> &'static str {
    if score >= 70 { "high" } else if score >= 40 { "medium" } else { "low" }
}

fn build_confidence(eligible: &[Value]) -> Value {
    let total_volume: f64 = eligible.iter().map(|m| m["volumeNum"].as_f64().unwrap_or(0.0)).sum();
    let total_oi: f64     = eligible.iter().map(|m| m["openInterest"].as_f64().unwrap_or(0.0)).sum();
    let count = eligible.len() as f64;
    let score = (
        (total_volume / 5000.0).min(40.0)
        + (total_oi / 5000.0).min(40.0)
        + (count * 10.0).min(20.0)
    ).round().clamp(0.0, 100.0) as i64;
    json!({"score": score, "label": confidence_label(score), "marketCount": count as i64, "totalVolume": total_volume, "totalOpenInterest": total_oi})
}

const MIN_VOLUME: f64 = 100.0;
const MIN_OI:     f64 = 100.0;
const MAX_SPREAD: f64 = 1.0;

pub async fn get_analysis(
    asset: &str,
    horizon: &str,
    spot: f64,
    client: &reqwest::Client,
    prices: &PriceCache,
    discovery: &DiscoveryCache,
    oi: &OiCache,
) -> anyhow::Result<Value> {
    let selected = get_selected_markets(asset, horizon, client, discovery).await?;
    let source_markets = build_source_markets(&selected, client, oi, prices).await;

    let expiry_date = selected.iter()
        .find_map(|m| m["event"]["endDate"].as_str().or_else(|| m["endDate"].as_str()))
        .map(|s| s.to_string());

    let eligible: Vec<Value> = source_markets.iter()
        .filter(|m| {
            m["volumeNum"].as_f64().unwrap_or(0.0) >= MIN_VOLUME
                && m["openInterest"].as_f64().unwrap_or(0.0) >= MIN_OI
                && m["spreadPct"].as_f64().unwrap_or(0.0) <= MAX_SPREAD
                && m["classification"]["type"] != "unknown"
        })
        .cloned()
        .collect();

    let path_markets: Vec<Value> = eligible.iter()
        .filter(|m| m["classification"]["type"] == "path")
        .cloned()
        .collect();

    let distribution  = build_distribution(&eligible);
    let summary       = summarize_distribution(&distribution, spot);
    let path_summary  = summarize_path_markets(&path_markets, spot);
    let confidence    = build_confidence(&eligible);

    Ok(json!({
        "asset": asset,
        "horizon": horizon,
        "expiryDate": expiry_date,
        "distribution": distribution,
        "summary": summary,
        "confidence": confidence,
        "pathSummary": path_summary,
        "repricing": {"change24h": null, "change7d": null},
        "sourceMarkets": source_markets,
        "eligibleMarkets": eligible,
        "pathMarkets": path_markets,
    }))
}

const SUPPORTED_HORIZONS: &[&str] = &["daily", "weekly", "monthly", "yearly"];

pub async fn get_surface(
    asset: &str,
    spot: f64,
    client: &reqwest::Client,
    prices: &PriceCache,
    discovery: &DiscoveryCache,
    oi: &OiCache,
) -> anyhow::Result<Value> {
    let now_iso = {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}", ms)
    };

    let mut horizons = serde_json::Map::new();
    for h in SUPPORTED_HORIZONS {
        match get_analysis(asset, h, spot, client, prices, discovery, oi).await {
            Ok(analysis) => { horizons.insert(h.to_string(), analysis); }
            Err(e) => { tracing::warn!("Polymarket analysis failed for {}/{}: {}", asset, h, e); }
        }
    }

    Ok(json!({
        "asset": asset,
        "generatedAt": now_iso,
        "horizons": horizons,
    }))
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

pub fn start_ws(
    prices: PriceCache,
    sse_senders: crate::sse::SseSenders,
    token_asset_map: TokenAssetMap,
    http_client: reqwest::Client,
    discovery: DiscoveryCache,
    oi: OiCache,
) {
    tokio::spawn(async move {
        let mut delay = RECONNECT_BASE_MS;
        loop {
            if let Err(e) = run_ws(&prices, &sse_senders, &token_asset_map, &http_client, &discovery, &oi).await {
                tracing::warn!("Polymarket WS disconnected: {}", e);
            }
            tokio::time::sleep(Duration::from_millis(delay)).await;
            delay = (delay * 2).min(RECONNECT_MAX_MS);
        }
    });
}

async fn run_ws(
    prices: &PriceCache,
    sse_senders: &crate::sse::SseSenders,
    token_asset_map: &TokenAssetMap,
    http_client: &reqwest::Client,
    discovery: &DiscoveryCache,
    oi: &OiCache,
) -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio_tungstenite::connect_async(WS_URL).await?;
    tracing::info!("Polymarket WS connected");

    // Re-subscribe to any already-known token IDs
    let known: Vec<String> = token_asset_map.read().await.keys().cloned().collect();
    if !known.is_empty() {
        let msg = json!({"type": "market", "assets_ids": known, "custom_feature_enabled": true});
        ws.send(Message::Text(msg.to_string())).await?;
    }

    while let Some(msg_result) = ws.next().await {
        let msg = msg_result?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };

        let payload: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let updates = extract_ws_updates(&payload);
        if updates.is_empty() { continue; }

        let mut affected: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let tam = token_asset_map.read().await;
            let mut pm = prices.write().await;
            for (token_id, price) in &updates {
                pm.insert(token_id.clone(), *price);
                if let Some(assets) = tam.get(token_id) {
                    for a in assets { affected.insert(a.clone()); }
                }
            }
        }

        for asset in &affected {
            let key = format!("polymarket:{}", asset);
            let has_sub = {
                let senders = sse_senders.read().await;
                senders.get(&key).map(|tx| tx.receiver_count() > 0).unwrap_or(false)
            };
            if !has_sub { continue; }

            match get_surface(asset, 0.0, http_client, prices, discovery, oi).await {
                Ok(surface) => {
                    let payload = serde_json::to_string(&surface).unwrap_or_default();
                    crate::sse::broadcast(sse_senders, &key, payload).await;
                }
                Err(e) => tracing::warn!("Polymarket surface broadcast error ({}): {}", asset, e),
            }
        }
    }

    Ok(())
}

fn extract_ws_updates(payload: &Value) -> Vec<(String, f64)> {
    let items: &[Value] = payload.as_array().map(|a| a.as_slice()).unwrap_or(std::slice::from_ref(payload));
    let mut out = Vec::new();
    for item in items {
        let Some(asset_id) = item["asset_id"].as_str()
            .or_else(|| item["assetId"].as_str())
            .or_else(|| item["market"].as_str())
            .or_else(|| item["token_id"].as_str())
            .or_else(|| item["tokenId"].as_str())
        else { continue; };

        let price = item["price"].as_f64()
            .or_else(|| item["last_trade_price"].as_f64())
            .or_else(|| item["lastTradePrice"].as_f64())
            .or_else(|| item["mid"].as_f64())
            .or_else(|| item["mid_price"].as_f64())
            .or_else(|| item["best_ask"].as_f64())
            .or_else(|| item["bestAsk"].as_f64())
            .or_else(|| midpoint_from_book(item));

        if let Some(p) = price {
            out.push((asset_id.to_string(), p));
        }
    }
    out
}

fn midpoint_from_book(item: &Value) -> Option<f64> {
    let bids = item["buys"].as_array().or_else(|| item["bids"].as_array())?;
    let asks = item["sells"].as_array().or_else(|| item["asks"].as_array())?;
    let bid = bids.first().and_then(|b| b["price"].as_f64().or_else(|| b["p"].as_f64()).or_else(|| b.as_f64()));
    let ask = asks.first().and_then(|a| a["price"].as_f64().or_else(|| a["p"].as_f64()).or_else(|| a.as_f64()));
    match (bid, ask) {
        (Some(b), Some(a)) if b >= 0.0 && a >= 0.0 => Some(((b + a) / 2.0 * 1e6).round() / 1e6),
        (Some(b), _) => Some(b),
        (_, Some(a)) => Some(a),
        _ => None,
    }
}
