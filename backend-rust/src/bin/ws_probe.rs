use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use tokio::time::{Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const NUMERIC_TOLERANCE: f64 = 1e-4;
const BYBIT_REST_BASE: &str = "https://api.bybit.com/v5";
const BYBIT_WS_URL: &str = "wss://stream.bybit.com/v5/public/option";
const BYBIT_COINS: &[&str] = &["BTC", "ETH", "SOL"];
const BYBIT_SUBSCRIBE_CHUNK: usize = 500;
const DERIBIT_REST_BASE: &str = "https://www.deribit.com/api/v2";
const DERIBIT_WS_URL: &str = "wss://www.deribit.com/ws/api/v2";
const DERIBIT_SUBSCRIBE_CHUNK: usize = 200;
const DERIBIT_COINS: &[(&str, &str, &str, Option<&str>)] = &[
    ("BTC", "BTC", "btc_usd", None),
    ("ETH", "ETH", "eth_usd", None),
    ("SOL", "USDC", "sol_usd", Some("SOL_USDC")),
];
const OKX_REST_BASE: &str = "https://www.okx.com/api/v5";
const OKX_WS_URL: &str = "wss://ws.okx.com:8443/ws/v5/public";
const OKX_FAMILIES: &[&str] = &["BTC-USD", "ETH-USD"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExchangeArg {
    Bybit,
    Deribit,
    Okx,
    All,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct NormalizedContract {
    symbol: String,
    strike: Option<f64>,
    option_type: Option<String>,
    bid: Option<f64>,
    ask: Option<f64>,
    last: Option<f64>,
    volume: Option<f64>,
    bid_size: Option<f64>,
    ask_size: Option<f64>,
    delta: Option<f64>,
    gamma: Option<f64>,
    theta: Option<f64>,
    vega: Option<f64>,
    implied_volatility: Option<f64>,
    mark_vol: Option<f64>,
    bid_vol: Option<f64>,
    ask_vol: Option<f64>,
    mark_price: Option<f64>,
    open_interest: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct NormalizedExpiration {
    expiry: String,
    calls: Vec<NormalizedContract>,
    puts: Vec<NormalizedContract>,
    forward_price: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct NormalizedExchangeSnapshot {
    exchange: String,
    spot_price: Option<f64>,
    expirations: Vec<NormalizedExpiration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FieldStatus {
    Match,
    Different,
    MissingFromWs,
    MissingFromRest,
}

#[derive(Debug, Clone, PartialEq)]
struct FieldComparison {
    field_name: &'static str,
    status: FieldStatus,
    rest_value: Option<f64>,
    ws_value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
struct ContractDiff {
    symbol: String,
    overall_status: FieldStatus,
    field_diffs: Vec<FieldComparison>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbeArgs {
    exchange: ExchangeArg,
    sample_seconds: u64,
    rust_base: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Viable,
    ViableWithCaveats,
    NotViable,
}

#[derive(Debug, Clone, Serialize)]
struct FieldCoverageSummary {
    field_name: &'static str,
    reference_present: usize,
    ws_present: usize,
    missing_in_ws: usize,
}

#[derive(Debug, Clone, Serialize)]
struct PairComparisonSummary {
    reference: String,
    reference_contracts: usize,
    ws_contracts: usize,
    matched_contracts: usize,
    differing_contracts: usize,
    missing_from_ws: usize,
    missing_from_reference: usize,
    field_coverage: Vec<FieldCoverageSummary>,
    spot_present_in_reference: bool,
    spot_present_in_ws: bool,
}

#[derive(Debug, Clone, Serialize)]
struct MarketReport {
    market: String,
    rest: PairComparisonSummary,
    rust: Option<PairComparisonSummary>,
    verdict: Verdict,
}

#[derive(Debug, Clone, Serialize)]
struct ExchangeReport {
    exchange: String,
    sample_seconds: u64,
    markets: Vec<MarketReport>,
    verdict: Verdict,
}

type BybitTickerCache = HashMap<String, HashMap<String, Value>>;

#[derive(Debug, Clone, Default, PartialEq)]
struct BybitCollectedData {
    tickers_by_coin: BybitTickerCache,
    spot_by_coin: HashMap<String, f64>,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedBybitSymbol {
    expiry: String,
    strike: f64,
    option_type: String,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedDeribitInstrument {
    expiry: String,
    strike: f64,
    option_type: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct DeribitRestSnapshot {
    spot_by_coin: HashMap<String, f64>,
    summaries_by_coin: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct DeribitWsSnapshot {
    spot_by_coin: HashMap<String, f64>,
    tickers_by_coin: HashMap<String, HashMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct OkxRestSnapshot {
    spot_by_inst_id: HashMap<String, f64>,
    tickers_by_family: HashMap<String, HashMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct OkxWsSnapshot {
    spot_by_inst_id: HashMap<String, f64>,
    summary_by_family: HashMap<String, HashMap<String, Value>>,
    tickers_by_family: HashMap<String, HashMap<String, Value>>,
}

fn parse_exchange_arg(args: &[String]) -> Result<ExchangeArg> {
    let exchange = args
        .first()
        .ok_or_else(|| anyhow!("missing exchange argument: expected bybit, deribit, okx, or all"))?;

    match exchange.as_str() {
        "bybit" => Ok(ExchangeArg::Bybit),
        "deribit" => Ok(ExchangeArg::Deribit),
        "okx" => Ok(ExchangeArg::Okx),
        "all" => Ok(ExchangeArg::All),
        _ => Err(anyhow!(
            "unsupported exchange argument {exchange:?}: expected bybit, deribit, okx, or all"
        )),
    }
}

fn parse_probe_args(args: &[String]) -> Result<ProbeArgs> {
    let exchange = parse_exchange_arg(args)?;
    let mut sample_seconds = 45u64;
    let mut rust_base = None;

    let mut index = 1usize;
    while index < args.len() {
        match args[index].as_str() {
            "--sample-seconds" => {
                let Some(value) = args.get(index + 1) else {
                    return Err(anyhow!("missing value after --sample-seconds"));
                };
                sample_seconds = value
                    .parse::<u64>()
                    .map_err(|_| anyhow!("invalid --sample-seconds value {value:?}"))?;
                index += 2;
            }
            "--rust-base" => {
                let Some(value) = args.get(index + 1) else {
                    return Err(anyhow!("missing value after --rust-base"));
                };
                rust_base = Some(value.clone());
                index += 2;
            }
            flag if flag.starts_with("--") => {
                return Err(anyhow!("unsupported flag {flag:?}"));
            }
            _ => {
                return Err(anyhow!("unexpected positional argument {:?}", args[index]));
            }
        }
    }

    Ok(ProbeArgs {
        exchange,
        sample_seconds,
        rust_base,
    })
}

fn compare_numeric_field(
    field_name: &'static str,
    rest_value: Option<f64>,
    ws_value: Option<f64>,
) -> FieldComparison {
    let status = match (rest_value, ws_value) {
        (Some(left), Some(right)) if (left - right).abs() <= NUMERIC_TOLERANCE => FieldStatus::Match,
        (Some(_), Some(_)) => FieldStatus::Different,
        (Some(_), None) => FieldStatus::MissingFromWs,
        (None, Some(_)) => FieldStatus::MissingFromRest,
        (None, None) => FieldStatus::Match,
    };

    FieldComparison {
        field_name,
        status,
        rest_value,
        ws_value,
    }
}

fn diff_contract(rest: &NormalizedContract, ws: &NormalizedContract) -> ContractDiff {
    let field_diffs = vec![
        compare_numeric_field("bid", rest.bid, ws.bid),
        compare_numeric_field("ask", rest.ask, ws.ask),
        compare_numeric_field("last", rest.last, ws.last),
        compare_numeric_field("volume", rest.volume, ws.volume),
        compare_numeric_field("bid_size", rest.bid_size, ws.bid_size),
        compare_numeric_field("ask_size", rest.ask_size, ws.ask_size),
        compare_numeric_field("delta", rest.delta, ws.delta),
        compare_numeric_field("gamma", rest.gamma, ws.gamma),
        compare_numeric_field("theta", rest.theta, ws.theta),
        compare_numeric_field("vega", rest.vega, ws.vega),
        compare_numeric_field(
            "implied_volatility",
            rest.implied_volatility,
            ws.implied_volatility,
        ),
        compare_numeric_field("mark_vol", rest.mark_vol, ws.mark_vol),
        compare_numeric_field("bid_vol", rest.bid_vol, ws.bid_vol),
        compare_numeric_field("ask_vol", rest.ask_vol, ws.ask_vol),
        compare_numeric_field("mark_price", rest.mark_price, ws.mark_price),
        compare_numeric_field("open_interest", rest.open_interest, ws.open_interest),
    ];

    let overall_status = if field_diffs
        .iter()
        .any(|diff| diff.status == FieldStatus::Different)
    {
        FieldStatus::Different
    } else if field_diffs
        .iter()
        .any(|diff| diff.status == FieldStatus::MissingFromWs)
    {
        FieldStatus::MissingFromWs
    } else if field_diffs
        .iter()
        .any(|diff| diff.status == FieldStatus::MissingFromRest)
    {
        FieldStatus::MissingFromRest
    } else {
        FieldStatus::Match
    };

    ContractDiff {
        symbol: rest.symbol.clone(),
        overall_status,
        field_diffs,
    }
}

fn parse_bybit_symbol(symbol: &str) -> Option<ParsedBybitSymbol> {
    let parts: Vec<&str> = symbol.split('-').collect();
    if parts.len() < 4 {
        return None;
    }

    let date_str = parts[1];
    let strike = parts[2].parse::<f64>().ok()?;
    let option_type = if parts[3] == "C" { "call" } else { "put" };

    let (day, month_str, year_str) = if date_str.len() == 6 {
        (&date_str[..1], &date_str[1..4], &date_str[4..6])
    } else if date_str.len() == 7 {
        (&date_str[..2], &date_str[2..5], &date_str[5..7])
    } else {
        return None;
    };

    let month = match month_str {
        "JAN" => 1,
        "FEB" => 2,
        "MAR" => 3,
        "APR" => 4,
        "MAY" => 5,
        "JUN" => 6,
        "JUL" => 7,
        "AUG" => 8,
        "SEP" => 9,
        "OCT" => 10,
        "NOV" => 11,
        "DEC" => 12,
        _ => return None,
    };
    let day = day.parse::<u32>().ok()?;
    let year = format!("20{year_str}").parse::<u32>().ok()?;

    Some(ParsedBybitSymbol {
        expiry: format!("{year}-{month:02}-{day:02}"),
        strike,
        option_type: option_type.to_string(),
    })
}

fn parse_deribit_instrument_name(name: &str) -> Option<ParsedDeribitInstrument> {
    let dash_idx = name.find('-')?;
    let rest = &name[dash_idx + 1..];
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() < 3 {
        return None;
    }

    let date_str = parts[0];
    let strike = parts[1].parse::<f64>().ok()?;
    let option_type = if parts[2] == "C" { "call" } else { "put" };

    let (day, month_str, year_str) = if date_str.len() == 6 {
        (&date_str[..1], &date_str[1..4], &date_str[4..6])
    } else if date_str.len() == 7 {
        (&date_str[..2], &date_str[2..5], &date_str[5..7])
    } else {
        return None;
    };

    let month = match month_str {
        "JAN" => 1,
        "FEB" => 2,
        "MAR" => 3,
        "APR" => 4,
        "MAY" => 5,
        "JUN" => 6,
        "JUL" => 7,
        "AUG" => 8,
        "SEP" => 9,
        "OCT" => 10,
        "NOV" => 11,
        "DEC" => 12,
        _ => return None,
    };
    let day = day.parse::<u32>().ok()?;
    let year = format!("20{year_str}").parse::<u32>().ok()?;

    Some(ParsedDeribitInstrument {
        expiry: format!("{year}-{month:02}-{day:02}"),
        strike,
        option_type: option_type.to_string(),
    })
}

fn parse_json_f64(value: &Value) -> Option<f64> {
    match value {
        Value::String(raw) => raw.parse::<f64>().ok(),
        Value::Number(raw) => raw.as_f64(),
        _ => None,
    }
}

fn normalize_bybit_rest_ticker(ticker: &Value) -> Value {
    json!({
        "symbol": ticker["symbol"].as_str().unwrap_or(""),
        "bid1Price": ticker["bid1Price"].as_str().unwrap_or("0"),
        "ask1Price": ticker["ask1Price"].as_str().unwrap_or("0"),
        "lastPrice": ticker["lastPrice"].as_str().unwrap_or("0"),
        "volume24h": ticker["volume24h"].as_str().unwrap_or("0"),
        "bid1Size": ticker["bid1Size"].as_str().unwrap_or("0"),
        "ask1Size": ticker["ask1Size"].as_str().unwrap_or("0"),
        "delta": ticker["delta"].as_str().unwrap_or("0"),
        "gamma": ticker["gamma"].as_str().unwrap_or("0"),
        "theta": ticker["theta"].as_str().unwrap_or("0"),
        "vega": ticker["vega"].as_str().unwrap_or("0"),
        "impliedVolatility": ticker["markIv"].as_str().unwrap_or("0"),
        "bid1Iv": ticker["bid1Iv"].as_str().unwrap_or("0"),
        "ask1Iv": ticker["ask1Iv"].as_str().unwrap_or("0"),
        "openInterest": ticker["openInterest"].as_str().unwrap_or("0"),
        "markPrice": ticker["markPrice"].as_str().unwrap_or("0"),
        "underlyingPrice": ticker["underlyingPrice"].as_str().unwrap_or("0"),
        "indexPrice": ticker["indexPrice"].as_str().unwrap_or("0"),
    })
}

fn normalize_bybit_ws_delta(data: &Value) -> Value {
    let mut out = serde_json::Map::new();

    if let Some(symbol) = data.get("symbol").and_then(Value::as_str) {
        out.insert("symbol".to_string(), Value::String(symbol.to_string()));
    }
    if let Some(value) = data.get("bidPrice") {
        out.insert("bid1Price".to_string(), value.clone());
    }
    if let Some(value) = data.get("askPrice") {
        out.insert("ask1Price".to_string(), value.clone());
    }
    if let Some(value) = data.get("lastPrice") {
        out.insert("lastPrice".to_string(), value.clone());
    }
    if let Some(value) = data.get("volume24h") {
        out.insert("volume24h".to_string(), value.clone());
    }
    if let Some(value) = data.get("bidSize") {
        out.insert("bid1Size".to_string(), value.clone());
    }
    if let Some(value) = data.get("askSize") {
        out.insert("ask1Size".to_string(), value.clone());
    }
    if let Some(value) = data.get("delta") {
        out.insert("delta".to_string(), value.clone());
    }
    if let Some(value) = data.get("gamma") {
        out.insert("gamma".to_string(), value.clone());
    }
    if let Some(value) = data.get("theta") {
        out.insert("theta".to_string(), value.clone());
    }
    if let Some(value) = data.get("vega") {
        out.insert("vega".to_string(), value.clone());
    }
    if let Some(value) = data.get("markPriceIv") {
        out.insert("impliedVolatility".to_string(), value.clone());
    }
    if let Some(value) = data.get("bid1Iv").or_else(|| data.get("bidIv")) {
        out.insert("bid1Iv".to_string(), value.clone());
    }
    if let Some(value) = data.get("ask1Iv").or_else(|| data.get("askIv")) {
        out.insert("ask1Iv".to_string(), value.clone());
    }
    if let Some(value) = data.get("openInterest") {
        out.insert("openInterest".to_string(), value.clone());
    }
    if let Some(value) = data.get("markPrice") {
        out.insert("markPrice".to_string(), value.clone());
    }
    if let Some(value) = data.get("underlyingPrice") {
        out.insert("underlyingPrice".to_string(), value.clone());
    }
    if let Some(value) = data.get("indexPrice") {
        out.insert("indexPrice".to_string(), value.clone());
    }

    Value::Object(out)
}

fn merge_bybit_ticker_snapshot(existing: &Value, ws_delta: &Value) -> Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    let normalized_delta = normalize_bybit_ws_delta(ws_delta);

    if let Some(delta_map) = normalized_delta.as_object() {
        for (key, value) in delta_map {
            merged.insert(key.clone(), value.clone());
        }
    }

    Value::Object(merged)
}

async fn fetch_bybit_instruments(client: &reqwest::Client, coin: &str) -> Result<Vec<String>> {
    let mut symbols = Vec::new();
    let mut cursor = String::new();

    loop {
        let mut url = format!(
            "{BYBIT_REST_BASE}/market/instruments-info?category=option&baseCoin={coin}&limit=500"
        );
        if !cursor.is_empty() {
            url.push_str("&cursor=");
            url.push_str(&cursor);
        }

        let body: Value = client
            .get(&url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;

        if let Some(list) = body["result"]["list"].as_array() {
            for item in list {
                if let Some(symbol) = item["symbol"].as_str() {
                    symbols.push(symbol.to_string());
                }
            }
        }

        cursor = body["result"]["nextPageCursor"]
            .as_str()
            .unwrap_or("")
            .to_string();
        if cursor.is_empty() {
            break;
        }
    }

    Ok(symbols)
}

async fn fetch_bybit_rest_snapshot(client: &reqwest::Client) -> Result<BybitCollectedData> {
    let mut collected = BybitCollectedData::default();

    for coin in BYBIT_COINS {
        let url = format!("{BYBIT_REST_BASE}/market/tickers?category=option&baseCoin={coin}");
        let body: Value = client
            .get(&url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;

        let mut coin_map = HashMap::new();
        let mut spot = None;
        if let Some(list) = body["result"]["list"].as_array() {
            for item in list {
                if let Some(symbol) = item["symbol"].as_str() {
                    coin_map.insert(symbol.to_string(), normalize_bybit_rest_ticker(item));
                }
                if spot.is_none() {
                    spot = item.get("indexPrice").and_then(parse_json_f64);
                }
            }
        }

        collected.tickers_by_coin.insert((*coin).to_string(), coin_map);
        if let Some(price) = spot.filter(|price| *price > 0.0) {
            collected.spot_by_coin.insert((*coin).to_string(), price);
        }
    }

    Ok(collected)
}

async fn collect_bybit_ws_snapshot(
    client: &reqwest::Client,
    sample_seconds: u64,
) -> Result<BybitCollectedData> {
    let mut collected = BybitCollectedData::default();
    let mut instruments = Vec::new();

    for coin in BYBIT_COINS {
        for symbol in fetch_bybit_instruments(client, coin).await? {
            instruments.push(symbol);
        }
    }

    let (ws_stream, _) = connect_async(BYBIT_WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    for chunk in instruments.chunks(BYBIT_SUBSCRIBE_CHUNK) {
        let args: Vec<String> = chunk.iter().map(|symbol| format!("tickers.{symbol}")).collect();
        let message = json!({
            "op": "subscribe",
            "args": args,
        });
        write.send(Message::Text(message.to_string())).await?;
    }

    let deadline = Instant::now() + Duration::from_secs(sample_seconds);
    let mut next_ping_at = Instant::now() + Duration::from_secs(20);

    while Instant::now() < deadline {
        let timeout = next_ping_at.saturating_duration_since(Instant::now());
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if parsed["op"].as_str() == Some("pong") || parsed["op"].as_str() == Some("subscribe") {
                    continue;
                }
                let Some(topic) = parsed["topic"].as_str() else {
                    continue;
                };
                if !topic.starts_with("tickers.") {
                    continue;
                }
                let Some(data) = parsed.get("data") else {
                    continue;
                };
                let Some(symbol) = data.get("symbol").and_then(Value::as_str) else {
                    continue;
                };
                let Some(coin) = symbol.split('-').next() else {
                    continue;
                };

                let coin_map = collected
                    .tickers_by_coin
                    .entry(coin.to_string())
                    .or_insert_with(HashMap::new);
                let existing = coin_map
                    .get(symbol)
                    .cloned()
                    .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                let merged = merge_bybit_ticker_snapshot(&existing, data);
                coin_map.insert(symbol.to_string(), merged);

                if let Some(index_price) = data.get("indexPrice").and_then(parse_json_f64) {
                    if index_price > 0.0 {
                        collected.spot_by_coin.insert(coin.to_string(), index_price);
                    }
                }
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                write.send(Message::Pong(payload)).await?;
            }
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(err))) => return Err(err.into()),
            Ok(None) => break,
            Err(_) => {
                write
                    .send(Message::Text(json!({"req_id": "hb", "op": "ping"}).to_string()))
                    .await?;
                next_ping_at = Instant::now() + Duration::from_secs(20);
            }
        }
    }

    Ok(collected)
}

fn normalize_bybit_snapshot(
    collected: &BybitCollectedData,
    coin: &str,
) -> Option<NormalizedExchangeSnapshot> {
    let tickers = collected.tickers_by_coin.get(coin)?;
    if tickers.is_empty() {
        return None;
    }

    let mut expirations: HashMap<String, NormalizedExpiration> = HashMap::new();

    for ticker in tickers.values() {
        let symbol = ticker.get("symbol").and_then(Value::as_str)?;
        let parsed = parse_bybit_symbol(symbol)?;
        let contract = NormalizedContract {
            symbol: symbol.to_string(),
            strike: Some(parsed.strike),
            option_type: Some(parsed.option_type.clone()),
            bid: ticker.get("bid1Price").and_then(parse_json_f64),
            ask: ticker.get("ask1Price").and_then(parse_json_f64),
            last: ticker.get("lastPrice").and_then(parse_json_f64),
            volume: ticker.get("volume24h").and_then(parse_json_f64),
            bid_size: ticker.get("bid1Size").and_then(parse_json_f64),
            ask_size: ticker.get("ask1Size").and_then(parse_json_f64),
            delta: ticker.get("delta").and_then(parse_json_f64),
            gamma: ticker.get("gamma").and_then(parse_json_f64),
            theta: ticker.get("theta").and_then(parse_json_f64),
            vega: ticker.get("vega").and_then(parse_json_f64),
            implied_volatility: ticker.get("impliedVolatility").and_then(parse_json_f64),
            mark_vol: ticker.get("impliedVolatility").and_then(parse_json_f64),
            bid_vol: ticker.get("bid1Iv").and_then(parse_json_f64),
            ask_vol: ticker.get("ask1Iv").and_then(parse_json_f64),
            mark_price: ticker.get("markPrice").and_then(parse_json_f64),
            open_interest: ticker.get("openInterest").and_then(parse_json_f64),
        };

        let entry = expirations
            .entry(parsed.expiry.clone())
            .or_insert_with(|| NormalizedExpiration {
                expiry: parsed.expiry.clone(),
                calls: Vec::new(),
                puts: Vec::new(),
                forward_price: ticker.get("underlyingPrice").and_then(parse_json_f64),
            });

        if parsed.option_type == "call" {
            entry.calls.push(contract);
        } else {
            entry.puts.push(contract);
        }
    }

    if expirations.is_empty() {
        return None;
    }

    let mut ordered_expirations: Vec<NormalizedExpiration> = expirations.into_values().collect();
    ordered_expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));

    Some(NormalizedExchangeSnapshot {
        exchange: "bybit".to_string(),
        spot_price: collected.spot_by_coin.get(coin).copied(),
        expirations: ordered_expirations,
    })
}

fn deribit_coin_multiplier(coin: &str, spot_price: f64) -> f64 {
    if coin == "SOL" { 1.0 } else { spot_price }
}

fn normalize_deribit_ws_contract(
    coin: &str,
    ticker: &Value,
    spot_price: f64,
) -> Option<(String, NormalizedContract, Option<f64>)> {
    let instrument_name = ticker.get("instrument_name").and_then(Value::as_str)?;
    let parsed = parse_deribit_instrument_name(instrument_name)?;
    let multiplier = deribit_coin_multiplier(coin, spot_price);

    let contract = NormalizedContract {
        symbol: instrument_name.to_string(),
        strike: Some(parsed.strike),
        option_type: Some(parsed.option_type.clone()),
        bid: ticker.get("best_bid_price").and_then(parse_json_f64).map(|v| v * multiplier),
        ask: ticker.get("best_ask_price").and_then(parse_json_f64).map(|v| v * multiplier),
        last: ticker.get("last_price").and_then(parse_json_f64).map(|v| v * multiplier),
        volume: ticker
            .get("stats")
            .and_then(|stats| stats.get("volume"))
            .and_then(parse_json_f64),
        delta: ticker
            .get("greeks")
            .and_then(|greeks| greeks.get("delta"))
            .and_then(parse_json_f64),
        gamma: ticker
            .get("greeks")
            .and_then(|greeks| greeks.get("gamma"))
            .and_then(parse_json_f64),
        theta: ticker
            .get("greeks")
            .and_then(|greeks| greeks.get("theta"))
            .and_then(parse_json_f64),
        vega: ticker
            .get("greeks")
            .and_then(|greeks| greeks.get("vega"))
            .and_then(parse_json_f64),
        implied_volatility: ticker.get("mark_iv").and_then(parse_json_f64).map(|v| v / 100.0),
        mark_vol: ticker.get("mark_iv").and_then(parse_json_f64).map(|v| v / 100.0),
        bid_vol: ticker.get("bid_iv").and_then(parse_json_f64).map(|v| v / 100.0),
        ask_vol: ticker.get("ask_iv").and_then(parse_json_f64).map(|v| v / 100.0),
        mark_price: ticker.get("mark_price").and_then(parse_json_f64).map(|v| v * multiplier),
        open_interest: ticker.get("open_interest").and_then(parse_json_f64),
        ..Default::default()
    };

    let forward_price = ticker.get("underlying_price").and_then(parse_json_f64);
    Some((parsed.expiry, contract, forward_price))
}

async fn fetch_deribit_rest_snapshot(client: &reqwest::Client) -> Result<DeribitRestSnapshot> {
    let mut snapshot = DeribitRestSnapshot::default();

    for (coin, currency, index_name, prefix) in DERIBIT_COINS {
        let spot_url = format!("{DERIBIT_REST_BASE}/public/get_index_price?index_name={index_name}");
        let spot_body: Value = client
            .get(&spot_url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;
        if let Some(price) = spot_body["result"]["index_price"].as_f64() {
            snapshot.spot_by_coin.insert((*coin).to_string(), price);
        }

        let sum_url = format!(
            "{DERIBIT_REST_BASE}/public/get_book_summary_by_currency?currency={currency}&kind=option"
        );
        let sum_body: Value = client
            .get(&sum_url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;
        let summaries = sum_body["result"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|summary| match prefix {
                Some(prefix_value) => summary["instrument_name"]
                    .as_str()
                    .map(|name| name.starts_with(prefix_value))
                    .unwrap_or(false),
                None => true,
            })
            .collect::<Vec<_>>();
        snapshot
            .summaries_by_coin
            .insert((*coin).to_string(), summaries);
    }

    Ok(snapshot)
}

async fn fetch_deribit_instruments(
    client: &reqwest::Client,
    currency: &str,
    prefix: Option<&str>,
) -> Result<Vec<String>> {
    let url = format!(
        "{DERIBIT_REST_BASE}/public/get_instruments?currency={currency}&kind=option&expired=false"
    );
    let body: Value = client
        .get(&url)
        .header("User-Agent", "ws-probe/1.0")
        .send()
        .await?
        .json()
        .await?;

    let mut instruments = body["result"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["instrument_name"].as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if let Some(prefix_value) = prefix {
        instruments.retain(|name| name.starts_with(prefix_value));
    }

    Ok(instruments)
}

async fn collect_deribit_ws_snapshot(
    client: &reqwest::Client,
    sample_seconds: u64,
) -> Result<DeribitWsSnapshot> {
    let mut snapshot = DeribitWsSnapshot::default();

    for (coin, _, index_name, _) in DERIBIT_COINS {
        let spot_url = format!("{DERIBIT_REST_BASE}/public/get_index_price?index_name={index_name}");
        let spot_body: Value = client
            .get(&spot_url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;
        if let Some(price) = spot_body["result"]["index_price"].as_f64() {
            snapshot.spot_by_coin.insert((*coin).to_string(), price);
        }
    }

    let mut subscriptions = Vec::new();
    let mut instrument_lookup = HashMap::new();
    for (coin, currency, _, prefix) in DERIBIT_COINS {
        for instrument in fetch_deribit_instruments(client, currency, *prefix).await? {
            subscriptions.push(format!("ticker.{instrument}.100ms"));
            instrument_lookup.insert(instrument, (*coin).to_string());
        }
    }

    let (ws_stream, _) = connect_async(DERIBIT_WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    for (chunk_idx, chunk) in subscriptions.chunks(DERIBIT_SUBSCRIBE_CHUNK).enumerate() {
        let channels: Vec<Value> = chunk.iter().map(|channel| Value::String(channel.clone())).collect();
        let subscribe = json!({
            "jsonrpc": "2.0",
            "method": "public/subscribe",
            "params": { "channels": channels },
            "id": format!("sub_{chunk_idx}")
        });
        write.send(Message::Text(subscribe.to_string())).await?;
    }

    let deadline = Instant::now() + Duration::from_secs(sample_seconds);
    let mut next_heartbeat_at = Instant::now() + Duration::from_secs(25);

    while Instant::now() < deadline {
        let timeout = next_heartbeat_at.saturating_duration_since(Instant::now());
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if parsed["method"].as_str() != Some("subscription") {
                    continue;
                }
                let Some(channel) = parsed["params"]["channel"].as_str() else {
                    continue;
                };
                let parts: Vec<&str> = channel.split('.').collect();
                if parts.len() < 2 {
                    continue;
                }
                let instrument_name = parts[1];
                let Some(coin) = instrument_lookup.get(instrument_name) else {
                    continue;
                };
                let Some(data) = parsed.get("params").and_then(|params| params.get("data")) else {
                    continue;
                };

                snapshot
                    .tickers_by_coin
                    .entry(coin.clone())
                    .or_insert_with(HashMap::new)
                    .insert(instrument_name.to_string(), data.clone());
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                write.send(Message::Pong(payload)).await?;
            }
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(err))) => return Err(err.into()),
            Ok(None) => break,
            Err(_) => {
                let heartbeat = json!({
                    "jsonrpc": "2.0",
                    "method": "public/test",
                    "id": "hb"
                });
                write.send(Message::Text(heartbeat.to_string())).await?;
                next_heartbeat_at = Instant::now() + Duration::from_secs(25);
            }
        }
    }

    Ok(snapshot)
}

fn normalize_deribit_rest_snapshot(
    snapshot: &DeribitRestSnapshot,
    coin: &str,
) -> Option<NormalizedExchangeSnapshot> {
    let summaries = snapshot.summaries_by_coin.get(coin)?;
    if summaries.is_empty() {
        return None;
    }
    let spot_price = snapshot.spot_by_coin.get(coin).copied().unwrap_or(0.0);
    let multiplier = deribit_coin_multiplier(coin, spot_price);
    let mut expirations: HashMap<String, NormalizedExpiration> = HashMap::new();

    for summary in summaries {
        let instrument_name = summary["instrument_name"].as_str()?;
        let parsed = parse_deribit_instrument_name(instrument_name)?;
        let contract = NormalizedContract {
            symbol: instrument_name.to_string(),
            strike: Some(parsed.strike),
            option_type: Some(parsed.option_type.clone()),
            bid: summary["bid_price"].as_f64().map(|v| v * multiplier),
            ask: summary["ask_price"].as_f64().map(|v| v * multiplier),
            last: summary["last"].as_f64().map(|v| v * multiplier),
            volume: summary["volume"].as_f64(),
            implied_volatility: summary["mark_iv"].as_f64().map(|v| v / 100.0),
            mark_vol: summary["mark_iv"].as_f64().map(|v| v / 100.0),
            mark_price: summary["mark_price"].as_f64().map(|v| v * multiplier),
            open_interest: summary["open_interest"].as_f64(),
            ..Default::default()
        };

        let entry = expirations
            .entry(parsed.expiry.clone())
            .or_insert_with(|| NormalizedExpiration {
                expiry: parsed.expiry.clone(),
                calls: Vec::new(),
                puts: Vec::new(),
                forward_price: summary["underlying_price"].as_f64(),
            });
        if parsed.option_type == "call" {
            entry.calls.push(contract);
        } else {
            entry.puts.push(contract);
        }
    }

    let mut ordered_expirations: Vec<NormalizedExpiration> = expirations.into_values().collect();
    ordered_expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));
    Some(NormalizedExchangeSnapshot {
        exchange: "deribit".to_string(),
        spot_price: snapshot.spot_by_coin.get(coin).copied(),
        expirations: ordered_expirations,
    })
}

fn normalize_deribit_ws_snapshot(
    snapshot: &DeribitWsSnapshot,
    coin: &str,
) -> Option<NormalizedExchangeSnapshot> {
    let tickers = snapshot.tickers_by_coin.get(coin)?;
    if tickers.is_empty() {
        return None;
    }
    let spot_price = snapshot.spot_by_coin.get(coin).copied().unwrap_or(0.0);
    let mut expirations: HashMap<String, NormalizedExpiration> = HashMap::new();

    for ticker in tickers.values() {
        let (expiry, contract, forward_price) =
            normalize_deribit_ws_contract(coin, ticker, spot_price)?;
        let entry = expirations
            .entry(expiry.clone())
            .or_insert_with(|| NormalizedExpiration {
                expiry,
                calls: Vec::new(),
                puts: Vec::new(),
                forward_price,
            });

        if contract.option_type.as_deref() == Some("call") {
            entry.calls.push(contract);
        } else {
            entry.puts.push(contract);
        }
    }

    let mut ordered_expirations: Vec<NormalizedExpiration> = expirations.into_values().collect();
    ordered_expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));
    Some(NormalizedExchangeSnapshot {
        exchange: "deribit".to_string(),
        spot_price: snapshot.spot_by_coin.get(coin).copied(),
        expirations: ordered_expirations,
    })
}

fn parse_okx_inst_id(inst_id: &str) -> Option<(String, f64, String)> {
    let parts: Vec<&str> = inst_id.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    let date_str = parts[2];
    if date_str.len() != 6 {
        return None;
    }

    let strike = parts[3].parse::<f64>().ok()?;
    let option_type = if parts[4] == "C" { "call" } else { "put" };
    let expiry = format!("20{}-{}-{}", &date_str[0..2], &date_str[2..4], &date_str[4..6]);
    Some((expiry, strike, option_type.to_string()))
}

fn okx_spot_key_for_family(inst_family: &str) -> &'static str {
    if inst_family.starts_with("BTC") {
        "BTC-USDT"
    } else {
        "ETH-USDT"
    }
}

fn normalize_okx_contract(
    summary: &Value,
    ticker: Option<&Value>,
    spot_price: f64,
) -> Option<(String, NormalizedContract, Option<f64>)> {
    let inst_id = summary.get("instId").and_then(Value::as_str)?;
    let (expiry, strike, option_type) = parse_okx_inst_id(inst_id)?;

    let bid = ticker.and_then(|item| item.get("bidPx")).and_then(parse_json_f64);
    let ask = ticker.and_then(|item| item.get("askPx")).and_then(parse_json_f64);
    let last = ticker.and_then(|item| item.get("last")).and_then(parse_json_f64);
    let volume = ticker
        .and_then(|item| item.get("vol24h"))
        .and_then(parse_json_f64)
        .filter(|value| *value > 0.0)
        .or_else(|| summary.get("vol24h").and_then(parse_json_f64));
    let bid_size = ticker.and_then(|item| item.get("bidSz")).and_then(parse_json_f64);
    let ask_size = ticker.and_then(|item| item.get("askSz")).and_then(parse_json_f64);

    let gamma_raw = summary.get("gamma").and_then(parse_json_f64);
    let theta_raw = summary.get("theta").and_then(parse_json_f64);
    let vega_raw = summary.get("vega").and_then(parse_json_f64);
    let gamma = gamma_raw.map(|value| if spot_price > 0.0 { value / spot_price } else { 0.0 });
    let theta = theta_raw.map(|value| value * spot_price);
    let vega = vega_raw.map(|value| value * spot_price);
    let mark_vol = summary.get("markVol").and_then(parse_json_f64);

    let contract = NormalizedContract {
        symbol: inst_id.to_string(),
        strike: Some(strike),
        option_type: Some(option_type),
        bid,
        ask,
        last,
        volume,
        bid_size,
        ask_size,
        delta: summary.get("delta").and_then(parse_json_f64),
        gamma,
        theta,
        vega,
        implied_volatility: mark_vol,
        mark_vol,
        bid_vol: summary.get("bidVol").and_then(parse_json_f64),
        ask_vol: summary.get("askVol").and_then(parse_json_f64),
        mark_price: Some(0.0),
        open_interest: summary.get("oi").and_then(parse_json_f64),
    };

    let forward_price = summary.get("fwdPx").and_then(parse_json_f64);
    Some((expiry, contract, forward_price))
}

async fn fetch_okx_rest_snapshot(client: &reqwest::Client) -> Result<OkxRestSnapshot> {
    let mut snapshot = OkxRestSnapshot::default();

    for family in OKX_FAMILIES {
        let url = format!("{OKX_REST_BASE}/market/tickers?instType=OPTION&instFamily={family}");
        let body: Value = client
            .get(&url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;
        let family_map = body["data"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["instId"].as_str().map(|inst_id| (inst_id.to_string(), item.clone())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        snapshot
            .tickers_by_family
            .insert((*family).to_string(), family_map);
    }

    for inst_id in ["BTC-USDT", "ETH-USDT"] {
        let url = format!("{OKX_REST_BASE}/market/ticker?instId={inst_id}");
        let body: Value = client
            .get(&url)
            .header("User-Agent", "ws-probe/1.0")
            .send()
            .await?
            .json()
            .await?;
        if let Some(price) = body["data"]
            .as_array()
            .and_then(|items| items.first())
            .and_then(|item| item.get("last"))
            .and_then(parse_json_f64)
        {
            snapshot.spot_by_inst_id.insert(inst_id.to_string(), price);
        }
    }

    Ok(snapshot)
}

async fn fetch_okx_option_instruments(client: &reqwest::Client, family: &str) -> Result<Vec<String>> {
    let url = format!("{OKX_REST_BASE}/public/instruments?instType=OPTION&instFamily={family}");
    let body: Value = client
        .get(&url)
        .header("User-Agent", "ws-probe/1.0")
        .send()
        .await?
        .json()
        .await?;

    Ok(body["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["instId"].as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

async fn collect_okx_ws_snapshot(client: &reqwest::Client, sample_seconds: u64) -> Result<OkxWsSnapshot> {
    let mut snapshot = OkxWsSnapshot::default();
    let mut option_instruments = HashMap::new();
    for family in OKX_FAMILIES {
        option_instruments.insert((*family).to_string(), fetch_okx_option_instruments(client, family).await?);
    }

    let (ws_stream, _) = connect_async(OKX_WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    let mut args = Vec::new();
    for family in OKX_FAMILIES {
        args.push(json!({"channel": "opt-summary", "instFamily": family}));
        for inst_id in option_instruments.get(*family).into_iter().flatten() {
            args.push(json!({"channel": "tickers", "instId": inst_id}));
        }
    }
    for inst_id in ["BTC-USDT", "ETH-USDT"] {
        args.push(json!({"channel": "tickers", "instId": inst_id}));
    }
    write
        .send(Message::Text(json!({"op": "subscribe", "args": args}).to_string()))
        .await?;

    let deadline = Instant::now() + Duration::from_secs(sample_seconds);
    let mut next_ping_at = Instant::now() + Duration::from_secs(25);

    while Instant::now() < deadline {
        let timeout = next_ping_at.saturating_duration_since(Instant::now());
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                if text == "pong" {
                    continue;
                }
                let parsed: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let Some(data) = parsed["data"].as_array() else {
                    continue;
                };
                let arg = &parsed["arg"];
                match arg["channel"].as_str() {
                    Some("opt-summary") => {
                        let Some(inst_family) = arg["instFamily"].as_str() else {
                            continue;
                        };
                        let family_map = snapshot
                            .summary_by_family
                            .entry(inst_family.to_string())
                            .or_insert_with(HashMap::new);
                        for item in data {
                            if let Some(inst_id) = item["instId"].as_str() {
                                family_map.insert(inst_id.to_string(), item.clone());
                            }
                        }
                    }
                    Some("tickers") => {
                        let Some(inst_id) = arg["instId"].as_str() else {
                            continue;
                        };
                        if inst_id.ends_with("USDT") && !inst_id.contains("-USD-") {
                            if let Some(item) = data.first() {
                                if let Some(price) = item.get("last").and_then(parse_json_f64) {
                                    snapshot.spot_by_inst_id.insert(inst_id.to_string(), price);
                                }
                            }
                        } else {
                            let family = inst_id
                                .split('-')
                                .take(2)
                                .collect::<Vec<_>>()
                                .join("-");
                            let family_map = snapshot
                                .tickers_by_family
                                .entry(family)
                                .or_insert_with(HashMap::new);
                            if let Some(item) = data.first() {
                                family_map.insert(inst_id.to_string(), item.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Some(Ok(Message::Ping(payload)))) => {
                write.send(Message::Pong(payload)).await?;
            }
            Ok(Some(Ok(Message::Close(_)))) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(err))) => return Err(err.into()),
            Ok(None) => break,
            Err(_) => {
                write.send(Message::Text("ping".to_string())).await?;
                next_ping_at = Instant::now() + Duration::from_secs(25);
            }
        }
    }

    Ok(snapshot)
}

fn normalize_okx_rest_snapshot(snapshot: &OkxRestSnapshot, family: &str) -> Option<NormalizedExchangeSnapshot> {
    let tickers = snapshot.tickers_by_family.get(family)?;
    if tickers.is_empty() {
        return None;
    }

    let spot_price = snapshot
        .spot_by_inst_id
        .get(okx_spot_key_for_family(family))
        .copied();
    let mut expirations: HashMap<String, NormalizedExpiration> = HashMap::new();

    for ticker in tickers.values() {
        let inst_id = ticker["instId"].as_str()?;
        let (expiry, strike, option_type) = parse_okx_inst_id(inst_id)?;
        let contract = NormalizedContract {
            symbol: inst_id.to_string(),
            strike: Some(strike),
            option_type: Some(option_type.clone()),
            bid: ticker.get("bidPx").and_then(parse_json_f64),
            ask: ticker.get("askPx").and_then(parse_json_f64),
            last: ticker.get("last").and_then(parse_json_f64),
            volume: ticker.get("vol24h").and_then(parse_json_f64),
            bid_size: ticker.get("bidSz").and_then(parse_json_f64),
            ask_size: ticker.get("askSz").and_then(parse_json_f64),
            ..Default::default()
        };
        let entry = expirations
            .entry(expiry.clone())
            .or_insert_with(|| NormalizedExpiration {
                expiry,
                calls: Vec::new(),
                puts: Vec::new(),
                forward_price: None,
            });
        if option_type == "call" {
            entry.calls.push(contract);
        } else {
            entry.puts.push(contract);
        }
    }

    let mut ordered_expirations: Vec<NormalizedExpiration> = expirations.into_values().collect();
    ordered_expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));
    Some(NormalizedExchangeSnapshot {
        exchange: "okx".to_string(),
        spot_price,
        expirations: ordered_expirations,
    })
}

fn normalize_okx_ws_snapshot(snapshot: &OkxWsSnapshot, family: &str) -> Option<NormalizedExchangeSnapshot> {
    let summaries = snapshot.summary_by_family.get(family)?;
    if summaries.is_empty() {
        return None;
    }

    let spot_price = snapshot
        .spot_by_inst_id
        .get(okx_spot_key_for_family(family))
        .copied()
        .unwrap_or(0.0);
    let empty_tickers = HashMap::new();
    let tickers = snapshot.tickers_by_family.get(family).unwrap_or(&empty_tickers);
    let mut expirations: HashMap<String, NormalizedExpiration> = HashMap::new();

    for (inst_id, summary) in summaries {
        let ticker = tickers.get(inst_id);
        let (expiry, contract, forward_price) = normalize_okx_contract(summary, ticker, spot_price)?;
        let entry = expirations
            .entry(expiry.clone())
            .or_insert_with(|| NormalizedExpiration {
                expiry,
                calls: Vec::new(),
                puts: Vec::new(),
                forward_price,
            });
        if contract.option_type.as_deref() == Some("call") {
            entry.calls.push(contract);
        } else {
            entry.puts.push(contract);
        }
    }

    let mut ordered_expirations: Vec<NormalizedExpiration> = expirations.into_values().collect();
    ordered_expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));
    Some(NormalizedExchangeSnapshot {
        exchange: "okx".to_string(),
        spot_price: snapshot
            .spot_by_inst_id
            .get(okx_spot_key_for_family(family))
            .copied(),
        expirations: ordered_expirations,
    })
}

fn flatten_snapshot(snapshot: &NormalizedExchangeSnapshot) -> HashMap<String, NormalizedContract> {
    let mut contracts = HashMap::new();
    for expiration in &snapshot.expirations {
        for contract in expiration.calls.iter().chain(expiration.puts.iter()) {
            contracts.insert(contract.symbol.clone(), contract.clone());
        }
    }
    contracts
}

fn contract_numeric_field(contract: &NormalizedContract, field_name: &'static str) -> Option<f64> {
    match field_name {
        "bid" => contract.bid,
        "ask" => contract.ask,
        "last" => contract.last,
        "volume" => contract.volume,
        "bid_size" => contract.bid_size,
        "ask_size" => contract.ask_size,
        "delta" => contract.delta,
        "gamma" => contract.gamma,
        "theta" => contract.theta,
        "vega" => contract.vega,
        "implied_volatility" => contract.implied_volatility,
        "mark_vol" => contract.mark_vol,
        "bid_vol" => contract.bid_vol,
        "ask_vol" => contract.ask_vol,
        "mark_price" => contract.mark_price,
        "open_interest" => contract.open_interest,
        _ => None,
    }
}

fn field_coverage_against_ws(
    reference_contracts: &HashMap<String, NormalizedContract>,
    ws_contracts: &HashMap<String, NormalizedContract>,
) -> Vec<FieldCoverageSummary> {
    const FIELDS: &[&str] = &[
        "bid",
        "ask",
        "last",
        "volume",
        "bid_size",
        "ask_size",
        "delta",
        "gamma",
        "theta",
        "vega",
        "implied_volatility",
        "mark_vol",
        "bid_vol",
        "ask_vol",
        "mark_price",
        "open_interest",
    ];

    let mut coverage = Vec::new();
    for field_name in FIELDS {
        let mut reference_present = 0usize;
        let mut ws_present = 0usize;
        let mut missing_in_ws = 0usize;
        for (symbol, reference_contract) in reference_contracts {
            if contract_numeric_field(reference_contract, field_name).is_some() {
                reference_present += 1;
                match ws_contracts
                    .get(symbol)
                    .and_then(|contract| contract_numeric_field(contract, field_name))
                {
                    Some(_) => ws_present += 1,
                    None => missing_in_ws += 1,
                }
            }
        }
        coverage.push(FieldCoverageSummary {
            field_name,
            reference_present,
            ws_present,
            missing_in_ws,
        });
    }
    coverage
}

fn compare_reference_to_ws(
    reference_name: &str,
    reference: &NormalizedExchangeSnapshot,
    ws: &NormalizedExchangeSnapshot,
) -> PairComparisonSummary {
    let reference_contracts = flatten_snapshot(reference);
    let ws_contracts = flatten_snapshot(ws);
    let mut matched_contracts = 0usize;
    let mut differing_contracts = 0usize;
    let mut missing_from_ws = 0usize;
    let mut missing_from_reference = 0usize;

    for (symbol, reference_contract) in &reference_contracts {
        match ws_contracts.get(symbol) {
            Some(ws_contract) => {
                let diff = diff_contract(reference_contract, ws_contract);
                if diff.overall_status == FieldStatus::Match {
                    matched_contracts += 1;
                } else {
                    differing_contracts += 1;
                }
            }
            None => missing_from_ws += 1,
        }
    }

    for symbol in ws_contracts.keys() {
        if !reference_contracts.contains_key(symbol) {
            missing_from_reference += 1;
        }
    }

    let field_coverage = field_coverage_against_ws(&reference_contracts, &ws_contracts);

    PairComparisonSummary {
        reference: reference_name.to_string(),
        reference_contracts: reference_contracts.len(),
        ws_contracts: ws_contracts.len(),
        matched_contracts,
        differing_contracts,
        missing_from_ws,
        missing_from_reference,
        field_coverage,
        spot_present_in_reference: reference.spot_price.is_some(),
        spot_present_in_ws: ws.spot_price.is_some(),
    }
}

fn verdict_for_pair(summary: &PairComparisonSummary) -> Verdict {
    if summary.missing_from_ws > 0 || summary.differing_contracts > 0 {
        Verdict::ViableWithCaveats
    } else {
        Verdict::Viable
    }
}

fn merge_verdict(current: Verdict, next: Verdict) -> Verdict {
    match (current, next) {
        (Verdict::NotViable, _) | (_, Verdict::NotViable) => Verdict::NotViable,
        (Verdict::ViableWithCaveats, _) | (_, Verdict::ViableWithCaveats) => Verdict::ViableWithCaveats,
        _ => Verdict::Viable,
    }
}

fn verdict_for_market(rest: &PairComparisonSummary, rust: Option<&PairComparisonSummary>) -> Verdict {
    let mut verdict = verdict_for_pair(rest);
    if let Some(rust_summary) = rust {
        verdict = merge_verdict(verdict, verdict_for_pair(rust_summary));
    }
    verdict
}

fn write_exchange_report(report: &ExchangeReport) -> Result<()> {
    fs::create_dir_all("ws-testing/reports")?;
    let slug = report.exchange.to_lowercase();
    let json_path = format!("ws-testing/reports/{slug}.json");
    let md_path = format!("ws-testing/reports/{slug}.md");

    fs::write(&json_path, serde_json::to_string_pretty(report)?)?;

    let mut summary = String::new();
    summary.push_str(&format!("# {} WS Feasibility Report\n\n", report.exchange));
    summary.push_str(&format!("- Sample window: {}s\n", report.sample_seconds));
    summary.push_str(&format!("- Verdict: {:?}\n\n", report.verdict));
    for market in &report.markets {
        summary.push_str(&format!("## {}\n\n", market.market));
        summary.push_str(&format!(
            "- REST vs WS: matched {} / {}, differing {}, missing from WS {}, missing from REST {}\n",
            market.rest.matched_contracts,
            market.rest.reference_contracts,
            market.rest.differing_contracts,
            market.rest.missing_from_ws,
            market.rest.missing_from_reference
        ));
        summary.push_str(&format!(
            "- REST spot present: {} | WS spot present: {}\n",
            market.rest.spot_present_in_reference,
            market.rest.spot_present_in_ws
        ));
        for field in &market.rest.field_coverage {
            summary.push_str(&format!(
                "- REST field `{}`: WS covers {}/{} contracts, missing {}\n",
                field.field_name,
                field.ws_present,
                field.reference_present,
                field.missing_in_ws
            ));
        }
        if let Some(rust_summary) = &market.rust {
            summary.push_str(&format!(
                "- Rust vs WS: matched {} / {}, differing {}, missing from WS {}, missing from Rust {}\n",
                rust_summary.matched_contracts,
                rust_summary.reference_contracts,
                rust_summary.differing_contracts,
                rust_summary.missing_from_ws,
                rust_summary.missing_from_reference
            ));
            summary.push_str(&format!(
                "- Rust spot present: {} | WS spot present: {}\n",
                rust_summary.spot_present_in_reference,
                rust_summary.spot_present_in_ws
            ));
        }
        summary.push_str(&format!("- Verdict: {:?}\n\n", market.verdict));
    }
    fs::write(&md_path, summary)?;
    Ok(())
}

fn normalize_backend_snapshot(exchange: &str, payload: &Value) -> Option<NormalizedExchangeSnapshot> {
    let spot_price = payload.get("spotPrice").and_then(parse_json_f64);
    let mut expirations = Vec::new();
    let data = payload.get("data")?.as_object()?;
    for (expiry, entry) in data {
        let forward_price = entry.get("forwardPrice").and_then(parse_json_f64);
        let calls = entry
            .get("calls")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(normalize_backend_contract).collect::<Vec<_>>())
            .unwrap_or_default();
        let puts = entry
            .get("puts")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(normalize_backend_contract).collect::<Vec<_>>())
            .unwrap_or_default();
        expirations.push(NormalizedExpiration {
            expiry: expiry.clone(),
            calls,
            puts,
            forward_price,
        });
    }
    expirations.sort_by(|left, right| left.expiry.cmp(&right.expiry));
    Some(NormalizedExchangeSnapshot {
        exchange: exchange.to_string(),
        spot_price,
        expirations,
    })
}

fn normalize_backend_contract(contract: &Value) -> Option<NormalizedContract> {
    Some(NormalizedContract {
        symbol: contract.get("symbol").and_then(Value::as_str)?.to_string(),
        strike: contract.get("strike").and_then(parse_json_f64),
        option_type: contract.get("optionType").and_then(Value::as_str).map(ToString::to_string),
        bid: contract.get("bid").and_then(parse_json_f64),
        ask: contract.get("ask").and_then(parse_json_f64),
        last: contract.get("last").and_then(parse_json_f64),
        volume: contract.get("volume").and_then(parse_json_f64),
        bid_size: contract.get("bidSize").and_then(parse_json_f64),
        ask_size: contract.get("askSize").and_then(parse_json_f64),
        delta: contract.get("delta").and_then(parse_json_f64),
        gamma: contract.get("gamma").and_then(parse_json_f64),
        theta: contract.get("theta").and_then(parse_json_f64),
        vega: contract.get("vega").and_then(parse_json_f64),
        implied_volatility: contract
            .get("impliedVolatility")
            .and_then(parse_json_f64),
        mark_vol: contract.get("markVol").and_then(parse_json_f64),
        bid_vol: contract.get("bidVol").and_then(parse_json_f64),
        ask_vol: contract.get("askVol").and_then(parse_json_f64),
        mark_price: contract.get("markPrice").and_then(parse_json_f64),
        open_interest: contract.get("openInterest").and_then(parse_json_f64),
    })
}

async fn fetch_backend_snapshot(
    client: &reqwest::Client,
    rust_base: &str,
    exchange: &str,
    market: &str,
) -> Result<Option<NormalizedExchangeSnapshot>> {
    let path = match exchange {
        "bybit" => format!("{rust_base}/api/options/{market}"),
        "deribit" => format!("{rust_base}/api/deribit/options/{market}"),
        "okx" => format!("{rust_base}/api/okx/options/{market}"),
        _ => return Ok(None),
    };

    let response = client.get(&path).send().await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await?;
    Ok(normalize_backend_snapshot(exchange, &body))
}

fn empty_snapshot(exchange: &str) -> NormalizedExchangeSnapshot {
    NormalizedExchangeSnapshot {
        exchange: exchange.to_string(),
        ..Default::default()
    }
}

async fn run_bybit_probe(client: &reqwest::Client, args: &ProbeArgs) -> Result<ExchangeReport> {
    let rest = fetch_bybit_rest_snapshot(client).await?;
    let ws = collect_bybit_ws_snapshot(client, args.sample_seconds).await?;
    let mut markets = Vec::new();
    let mut overall = Verdict::Viable;

    for coin in BYBIT_COINS {
        let Some(rest_snapshot) = normalize_bybit_snapshot(&rest, coin) else {
            continue;
        };
        let ws_snapshot = normalize_bybit_snapshot(&ws, coin).unwrap_or_else(|| empty_snapshot("bybit"));
        let rest_summary = compare_reference_to_ws("rest", &rest_snapshot, &ws_snapshot);
        let rust_summary = if let Some(rust_base) = &args.rust_base {
            fetch_backend_snapshot(client, rust_base, "bybit", coin)
                .await?
                .map(|snapshot| compare_reference_to_ws("rust", &snapshot, &ws_snapshot))
        } else {
            None
        };
        let verdict = verdict_for_market(&rest_summary, rust_summary.as_ref());
        overall = merge_verdict(overall, verdict.clone());
        markets.push(MarketReport {
            market: (*coin).to_string(),
            rest: rest_summary,
            rust: rust_summary,
            verdict,
        });
    }

    Ok(ExchangeReport {
        exchange: "bybit".to_string(),
        sample_seconds: args.sample_seconds,
        markets,
        verdict: overall,
    })
}

async fn run_deribit_probe(client: &reqwest::Client, args: &ProbeArgs) -> Result<ExchangeReport> {
    let rest = fetch_deribit_rest_snapshot(client).await?;
    let ws = collect_deribit_ws_snapshot(client, args.sample_seconds).await?;
    let mut markets = Vec::new();
    let mut overall = Verdict::Viable;

    for (coin, _, _, _) in DERIBIT_COINS {
        let Some(rest_snapshot) = normalize_deribit_rest_snapshot(&rest, coin) else {
            continue;
        };
        let ws_snapshot =
            normalize_deribit_ws_snapshot(&ws, coin).unwrap_or_else(|| empty_snapshot("deribit"));
        let rest_summary = compare_reference_to_ws("rest", &rest_snapshot, &ws_snapshot);
        let rust_summary = if let Some(rust_base) = &args.rust_base {
            fetch_backend_snapshot(client, rust_base, "deribit", coin)
                .await?
                .map(|snapshot| compare_reference_to_ws("rust", &snapshot, &ws_snapshot))
        } else {
            None
        };
        let verdict = verdict_for_market(&rest_summary, rust_summary.as_ref());
        overall = merge_verdict(overall, verdict.clone());
        markets.push(MarketReport {
            market: (*coin).to_string(),
            rest: rest_summary,
            rust: rust_summary,
            verdict,
        });
    }

    Ok(ExchangeReport {
        exchange: "deribit".to_string(),
        sample_seconds: args.sample_seconds,
        markets,
        verdict: overall,
    })
}

async fn run_okx_probe(client: &reqwest::Client, args: &ProbeArgs) -> Result<ExchangeReport> {
    let rest = fetch_okx_rest_snapshot(client).await?;
    let ws = collect_okx_ws_snapshot(client, args.sample_seconds).await?;
    let mut markets = Vec::new();
    let mut overall = Verdict::Viable;

    for family in OKX_FAMILIES {
        let Some(rest_snapshot) = normalize_okx_rest_snapshot(&rest, family) else {
            continue;
        };
        let ws_snapshot =
            normalize_okx_ws_snapshot(&ws, family).unwrap_or_else(|| empty_snapshot("okx"));
        let rest_summary = compare_reference_to_ws("rest", &rest_snapshot, &ws_snapshot);
        let rust_summary = if let Some(rust_base) = &args.rust_base {
            fetch_backend_snapshot(client, rust_base, "okx", family)
                .await?
                .map(|snapshot| compare_reference_to_ws("rust", &snapshot, &ws_snapshot))
        } else {
            None
        };
        let verdict = verdict_for_market(&rest_summary, rust_summary.as_ref());
        overall = merge_verdict(overall, verdict.clone());
        markets.push(MarketReport {
            market: (*family).to_string(),
            rest: rest_summary,
            rust: rust_summary,
            verdict,
        });
    }

    Ok(ExchangeReport {
        exchange: "okx".to_string(),
        sample_seconds: args.sample_seconds,
        markets,
        verdict: overall,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_probe_args(&raw_args)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let reports = match args.exchange {
        ExchangeArg::Bybit => vec![run_bybit_probe(&client, &args).await?],
        ExchangeArg::Deribit => vec![run_deribit_probe(&client, &args).await?],
        ExchangeArg::Okx => vec![run_okx_probe(&client, &args).await?],
        ExchangeArg::All => {
            vec![
                run_bybit_probe(&client, &args).await?,
                run_deribit_probe(&client, &args).await?,
                run_okx_probe(&client, &args).await?,
            ]
        }
    };

    for report in &reports {
        write_exchange_report(report)?;
        println!("{} verdict: {:?}", report.exchange, report.verdict);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    fn assert_close(left: Option<f64>, right: Option<f64>) {
        match (left, right) {
            (Some(left), Some(right)) => assert!((left - right).abs() <= super::NUMERIC_TOLERANCE),
            (None, None) => {}
            _ => panic!("values differ: left={left:?} right={right:?}"),
        }
    }

    #[test]
    fn cli_requires_exchange_argument() {
        let args: Vec<String> = vec![];
        let result = super::parse_exchange_arg(&args);
        assert!(result.is_err());
    }

    #[test]
    fn cli_accepts_supported_exchange_argument() {
        let args = vec!["bybit".to_string()];
        let result = super::parse_exchange_arg(&args).unwrap();
        assert_eq!(result, super::ExchangeArg::Bybit);
    }

    #[test]
    fn contract_diff_uses_tolerance() {
        let left = super::NormalizedContract {
            symbol: "BTC-TEST".to_string(),
            bid: Some(100.0),
            ask: Some(101.0),
            mark_price: Some(100.5),
            open_interest: Some(250.0),
            ..Default::default()
        };
        let right = super::NormalizedContract {
            symbol: "BTC-TEST".to_string(),
            bid: Some(100.00001),
            ask: Some(101.00001),
            mark_price: Some(100.50001),
            open_interest: Some(250.00001),
            ..Default::default()
        };

        let diff = super::diff_contract(&left, &right);
        assert_eq!(diff.overall_status, super::FieldStatus::Match);
    }

    #[test]
    fn bybit_delta_merge_preserves_existing_fields() {
        let initial = serde_json::json!({
            "symbol": "BTC-28MAR26-80000-C",
            "bid1Price": "123",
            "ask1Price": "125",
            "lastPrice": "124",
            "volume24h": "55",
            "bid1Size": "3",
            "ask1Size": "2",
            "delta": "0.4",
            "gamma": "0.01",
            "theta": "-0.2",
            "vega": "1.2",
            "impliedVolatility": "0.65",
            "openInterest": "80",
            "markPrice": "124.5",
            "underlyingPrice": "84000"
        });
        let delta = serde_json::json!({
            "symbol": "BTC-28MAR26-80000-C",
            "askPrice": "126",
            "bidSize": "4"
        });

        let merged = super::merge_bybit_ticker_snapshot(&initial, &delta);
        assert_eq!(merged["bid1Price"], "123");
        assert_eq!(merged["ask1Price"], "126");
        assert_eq!(merged["bid1Size"], "4");
        assert_eq!(merged["lastPrice"], "124");
    }

    #[test]
    fn bybit_normalization_groups_contracts_by_expiry() {
        let mut collected = super::BybitCollectedData::default();
        collected.tickers_by_coin.insert(
            "BTC".to_string(),
            HashMap::from([
                (
                    "BTC-28MAR26-80000-C".to_string(),
                    serde_json::json!({
                        "symbol": "BTC-28MAR26-80000-C",
                        "bid1Price": "123",
                        "ask1Price": "125",
                        "lastPrice": "124",
                        "volume24h": "55",
                        "bid1Size": "3",
                        "ask1Size": "2",
                        "delta": "0.4",
                        "gamma": "0.01",
                        "theta": "-0.2",
                        "vega": "1.2",
                        "impliedVolatility": "0.65",
                        "bid1Iv": "0.64",
                        "ask1Iv": "0.66",
                        "openInterest": "80",
                        "markPrice": "124.5",
                        "underlyingPrice": "84000"
                    }),
                ),
                (
                    "BTC-28MAR26-80000-P".to_string(),
                    serde_json::json!({
                        "symbol": "BTC-28MAR26-80000-P",
                        "bid1Price": "122",
                        "ask1Price": "126",
                        "lastPrice": "123",
                        "volume24h": "35",
                        "bid1Size": "1",
                        "ask1Size": "5",
                        "delta": "-0.6",
                        "gamma": "0.02",
                        "theta": "-0.3",
                        "vega": "1.4",
                        "impliedVolatility": "0.68",
                        "bid1Iv": "0.67",
                        "ask1Iv": "0.69",
                        "openInterest": "70",
                        "markPrice": "123.5",
                        "underlyingPrice": "84000"
                    }),
                ),
            ]),
        );
        collected.spot_by_coin.insert("BTC".to_string(), 83850.0);

        let snapshot = super::normalize_bybit_snapshot(&collected, "BTC").unwrap();
        assert_eq!(snapshot.exchange, "bybit");
        assert_eq!(snapshot.spot_price, Some(83850.0));
        assert_eq!(snapshot.expirations.len(), 1);
        assert_eq!(snapshot.expirations[0].calls.len(), 1);
        assert_eq!(snapshot.expirations[0].puts.len(), 1);
        assert_eq!(snapshot.expirations[0].forward_price, Some(84000.0));
    }

    #[test]
    fn deribit_ws_normalization_covers_builder_fields() {
        let ws_ticker = serde_json::json!({
            "instrument_name": "BTC-28MAR26-80000-C",
            "best_bid_price": 0.12,
            "best_ask_price": 0.14,
            "last_price": 0.13,
            "mark_price": 0.135,
            "stats": { "volume": 125.0 },
            "open_interest": 450.0,
            "mark_iv": 65.0,
            "bid_iv": 64.0,
            "ask_iv": 66.0,
            "underlying_price": 84500.0,
            "greeks": {
                "delta": 0.42,
                "gamma": 0.012,
                "theta": -0.03,
                "vega": 0.15
            }
        });

        let (expiry, contract, forward_price) =
            super::normalize_deribit_ws_contract("BTC", &ws_ticker, 84500.0).unwrap();

        assert_eq!(expiry, "2026-03-28");
        assert_close(forward_price, Some(84500.0));
        assert_eq!(contract.symbol, "BTC-28MAR26-80000-C");
        assert_close(contract.bid, Some(10140.0));
        assert_close(contract.ask, Some(11830.0));
        assert_close(contract.last, Some(10985.0));
        assert_close(contract.mark_price, Some(11407.5));
        assert_close(contract.volume, Some(125.0));
        assert_close(contract.open_interest, Some(450.0));
        assert_close(contract.implied_volatility, Some(0.65));
        assert_close(contract.bid_vol, Some(0.64));
        assert_close(contract.ask_vol, Some(0.66));
        assert_close(contract.delta, Some(0.42));
        assert_close(contract.gamma, Some(0.012));
        assert_close(contract.theta, Some(-0.03));
        assert_close(contract.vega, Some(0.15));
    }

    #[test]
    fn deribit_ws_snapshot_groups_contracts_by_expiry() {
        let mut snapshot = super::DeribitWsSnapshot::default();
        snapshot.spot_by_coin.insert("BTC".to_string(), 84500.0);
        snapshot.tickers_by_coin.insert(
            "BTC".to_string(),
            HashMap::from([
                (
                    "BTC-28MAR26-80000-C".to_string(),
                    serde_json::json!({
                        "instrument_name": "BTC-28MAR26-80000-C",
                        "best_bid_price": 0.12,
                        "best_ask_price": 0.14,
                        "last_price": 0.13,
                        "mark_price": 0.135,
                        "stats": { "volume": 125.0 },
                        "open_interest": 450.0,
                        "mark_iv": 65.0,
                        "bid_iv": 64.0,
                        "ask_iv": 66.0,
                        "underlying_price": 84500.0,
                        "greeks": { "delta": 0.42, "gamma": 0.012, "theta": -0.03, "vega": 0.15 }
                    }),
                ),
                (
                    "BTC-28MAR26-80000-P".to_string(),
                    serde_json::json!({
                        "instrument_name": "BTC-28MAR26-80000-P",
                        "best_bid_price": 0.11,
                        "best_ask_price": 0.13,
                        "last_price": 0.12,
                        "mark_price": 0.125,
                        "stats": { "volume": 75.0 },
                        "open_interest": 300.0,
                        "mark_iv": 67.0,
                        "bid_iv": 66.0,
                        "ask_iv": 68.0,
                        "underlying_price": 84500.0,
                        "greeks": { "delta": -0.58, "gamma": 0.013, "theta": -0.02, "vega": 0.14 }
                    }),
                ),
            ]),
        );

        let normalized = super::normalize_deribit_ws_snapshot(&snapshot, "BTC").unwrap();
        assert_eq!(normalized.exchange, "deribit");
        assert_close(normalized.spot_price, Some(84500.0));
        assert_eq!(normalized.expirations.len(), 1);
        assert_eq!(normalized.expirations[0].calls.len(), 1);
        assert_eq!(normalized.expirations[0].puts.len(), 1);
        assert_close(normalized.expirations[0].forward_price, Some(84500.0));
    }

    #[test]
    fn okx_merge_combines_summary_and_ticker_fields() {
        let summary = serde_json::json!({
            "instId": "BTC-USD-260328-80000-C",
            "delta": "0.42",
            "gamma": "10.0",
            "theta": "-0.0002",
            "vega": "0.0004",
            "markVol": "0.65",
            "bidVol": "0.64",
            "askVol": "0.66",
            "oi": "150",
            "fwdPx": "84500",
            "vol24h": "12"
        });
        let ticker = serde_json::json!({
            "instId": "BTC-USD-260328-80000-C",
            "bidPx": "123",
            "askPx": "125",
            "last": "124",
            "vol24h": "18",
            "bidSz": "2",
            "askSz": "3"
        });

        let (expiry, contract, forward_price) =
            super::normalize_okx_contract(&summary, Some(&ticker), 84000.0).unwrap();

        assert_eq!(expiry, "2026-03-28");
        assert_close(forward_price, Some(84500.0));
        assert_eq!(contract.symbol, "BTC-USD-260328-80000-C");
        assert_close(contract.bid, Some(123.0));
        assert_close(contract.ask, Some(125.0));
        assert_close(contract.last, Some(124.0));
        assert_close(contract.volume, Some(18.0));
        assert_close(contract.bid_size, Some(2.0));
        assert_close(contract.ask_size, Some(3.0));
        assert_close(contract.delta, Some(0.42));
        assert_close(contract.gamma, Some(10.0 / 84000.0));
        assert_close(contract.theta, Some(-0.0002 * 84000.0));
        assert_close(contract.vega, Some(0.0004 * 84000.0));
        assert_close(contract.implied_volatility, Some(0.65));
        assert_close(contract.bid_vol, Some(0.64));
        assert_close(contract.ask_vol, Some(0.66));
        assert_close(contract.open_interest, Some(150.0));
    }

    #[test]
    fn okx_ws_snapshot_groups_contracts_by_expiry() {
        let mut snapshot = super::OkxWsSnapshot::default();
        snapshot
            .spot_by_inst_id
            .insert("BTC-USDT".to_string(), 84000.0);
        snapshot.summary_by_family.insert(
            "BTC-USD".to_string(),
            HashMap::from([
                (
                    "BTC-USD-260328-80000-C".to_string(),
                    serde_json::json!({
                        "instId": "BTC-USD-260328-80000-C",
                        "delta": "0.42",
                        "gamma": "10.0",
                        "theta": "-0.0002",
                        "vega": "0.0004",
                        "markVol": "0.65",
                        "bidVol": "0.64",
                        "askVol": "0.66",
                        "oi": "150",
                        "fwdPx": "84500",
                        "vol24h": "12"
                    }),
                ),
                (
                    "BTC-USD-260328-80000-P".to_string(),
                    serde_json::json!({
                        "instId": "BTC-USD-260328-80000-P",
                        "delta": "-0.58",
                        "gamma": "11.0",
                        "theta": "-0.0003",
                        "vega": "0.0005",
                        "markVol": "0.67",
                        "bidVol": "0.66",
                        "askVol": "0.68",
                        "oi": "180",
                        "fwdPx": "84500",
                        "vol24h": "10"
                    }),
                ),
            ]),
        );
        snapshot.tickers_by_family.insert(
            "BTC-USD".to_string(),
            HashMap::from([
                (
                    "BTC-USD-260328-80000-C".to_string(),
                    serde_json::json!({
                        "instId": "BTC-USD-260328-80000-C",
                        "bidPx": "123",
                        "askPx": "125",
                        "last": "124",
                        "vol24h": "18",
                        "bidSz": "2",
                        "askSz": "3"
                    }),
                ),
                (
                    "BTC-USD-260328-80000-P".to_string(),
                    serde_json::json!({
                        "instId": "BTC-USD-260328-80000-P",
                        "bidPx": "122",
                        "askPx": "126",
                        "last": "123",
                        "vol24h": "15",
                        "bidSz": "4",
                        "askSz": "5"
                    }),
                ),
            ]),
        );

        let normalized = super::normalize_okx_ws_snapshot(&snapshot, "BTC-USD").unwrap();
        assert_eq!(normalized.exchange, "okx");
        assert_close(normalized.spot_price, Some(84000.0));
        assert_eq!(normalized.expirations.len(), 1);
        assert_eq!(normalized.expirations[0].calls.len(), 1);
        assert_eq!(normalized.expirations[0].puts.len(), 1);
        assert_close(normalized.expirations[0].forward_price, Some(84500.0));
    }

    #[test]
    fn verdict_downgrades_on_missing_ws_fields() {
        let summary = super::PairComparisonSummary {
            reference: "rest".to_string(),
            reference_contracts: 10,
            ws_contracts: 8,
            matched_contracts: 8,
            differing_contracts: 0,
            missing_from_ws: 2,
            missing_from_reference: 0,
            field_coverage: vec![],
            spot_present_in_reference: true,
            spot_present_in_ws: false,
        };

        assert_eq!(
            super::verdict_for_market(&summary, None),
            super::Verdict::ViableWithCaveats
        );
    }

    #[test]
    fn field_coverage_counts_missing_ws_fields_per_contract() {
        let reference = HashMap::from([(
            "BTC-TEST".to_string(),
            super::NormalizedContract {
                symbol: "BTC-TEST".to_string(),
                bid: Some(1.0),
                ask: Some(2.0),
                delta: Some(0.4),
                ..Default::default()
            },
        )]);
        let ws = HashMap::from([(
            "BTC-TEST".to_string(),
            super::NormalizedContract {
                symbol: "BTC-TEST".to_string(),
                bid: Some(1.0),
                ..Default::default()
            },
        )]);

        let coverage = super::field_coverage_against_ws(&reference, &ws);
        let bid = coverage.iter().find(|field| field.field_name == "bid").unwrap();
        let ask = coverage.iter().find(|field| field.field_name == "ask").unwrap();
        let delta = coverage.iter().find(|field| field.field_name == "delta").unwrap();

        assert_eq!(bid.reference_present, 1);
        assert_eq!(bid.ws_present, 1);
        assert_eq!(bid.missing_in_ws, 0);
        assert_eq!(ask.reference_present, 1);
        assert_eq!(ask.ws_present, 0);
        assert_eq!(ask.missing_in_ws, 1);
        assert_eq!(delta.reference_present, 1);
        assert_eq!(delta.ws_present, 0);
        assert_eq!(delta.missing_in_ws, 1);
    }
}
