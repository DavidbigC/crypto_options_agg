use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

struct MergedContract {
    strike: f64,
    option_type: String,
    best_bid: f64,
    best_bid_ex: String,
    best_ask: f64,
    best_ask_ex: String,
    prices: HashMap<String, (f64, f64)>, // exchange -> (bid, ask)
    delta: f64,
    gamma: f64,
    theta: f64,
    vega: f64,
    mark_vol: f64,
    bid_vol: f64,
    ask_vol: f64,
}

impl MergedContract {
    fn new(strike: f64, option_type: String) -> Self {
        let mut prices = HashMap::new();
        for ex in &["bybit", "okx", "deribit", "derive", "binance"] {
            prices.insert(ex.to_string(), (0.0, 0.0));
        }
        Self {
            strike,
            option_type,
            best_bid: 0.0,
            best_bid_ex: String::new(),
            best_ask: 0.0,
            best_ask_ex: String::new(),
            prices,
            delta: 0.0,
            gamma: 0.0,
            theta: 0.0,
            vega: 0.0,
            mark_vol: 0.0,
            bid_vol: 0.0,
            ask_vol: 0.0,
        }
    }

    fn to_value(&self) -> Value {
        let prices_obj: serde_json::Map<String, Value> = self
            .prices
            .iter()
            .map(|(ex, (bid, ask))| {
                (
                    ex.clone(),
                    json!({ "bid": bid, "ask": ask }),
                )
            })
            .collect();

        json!({
            "strike":     self.strike,
            "optionType": self.option_type,
            "bestBid":    self.best_bid,
            "bestBidEx":  self.best_bid_ex,
            "bestAsk":    self.best_ask,
            "bestAskEx":  self.best_ask_ex,
            "prices":     prices_obj,
            "delta":      self.delta,
            "gamma":      self.gamma,
            "theta":      self.theta,
            "vega":       self.vega,
            "markVol":    self.mark_vol,
            "bidVol":     self.bid_vol,
            "askVol":     self.ask_vol,
        })
    }
}

fn parse_f64(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn merge_exchange_data(
    merged: &mut HashMap<String, MergedContract>,
    forward_prices: &mut HashMap<String, f64>,
    exchange_name: &str,
    response: &Value,
    bid_multiplier: f64,  // for OKX: spot_price; for others: 1.0
) {
    let data = match response["data"].as_object() {
        Some(d) => d,
        None => return,
    };

    for (expiry, expiry_data) in data {
        // forwardPrice: first non-zero wins
        let fwd = parse_f64(&expiry_data["forwardPrice"]);
        if fwd > 0.0 {
            forward_prices.entry(expiry.clone()).or_insert(fwd);
        }

        for option_type in &["calls", "puts"] {
            let contracts = match expiry_data[option_type].as_array() {
                Some(arr) => arr,
                None => continue,
            };

            for contract in contracts {
                let strike = parse_f64(&contract["strike"]);
                let opt_type = contract["optionType"].as_str().unwrap_or("").to_string();
                let key = format!("{}|{}|{}", expiry, strike, opt_type);

                let entry = merged
                    .entry(key)
                    .or_insert_with(|| MergedContract::new(strike, opt_type));

                let raw_bid = parse_f64(&contract["bid"]);
                let raw_ask = parse_f64(&contract["ask"]);
                let bid = raw_bid * bid_multiplier;
                let ask = raw_ask * bid_multiplier;

                // Update per-exchange prices
                entry.prices.insert(exchange_name.to_string(), (bid, ask));

                // bestBid: highest bid wins
                if bid > entry.best_bid {
                    entry.best_bid = bid;
                    entry.best_bid_ex = exchange_name.to_string();
                }

                // bestAsk: lowest ask wins (ask > 0)
                if ask > 0.0 && (entry.best_ask == 0.0 || ask < entry.best_ask) {
                    entry.best_ask = ask;
                    entry.best_ask_ex = exchange_name.to_string();
                }

                // Greeks: last non-zero wins
                let delta = parse_f64(&contract["delta"]);
                let gamma = parse_f64(&contract["gamma"]);
                let theta = parse_f64(&contract["theta"]);
                let vega = parse_f64(&contract["vega"]);
                let mark_vol = parse_f64(&contract["markVol"]);
                let bid_vol = parse_f64(&contract["bidVol"]);
                let ask_vol = parse_f64(&contract["askVol"]);

                if delta != 0.0 { entry.delta = delta; }
                if gamma != 0.0 { entry.gamma = gamma; }
                if theta != 0.0 { entry.theta = theta; }
                if vega != 0.0 { entry.vega = vega; }
                if mark_vol != 0.0 { entry.mark_vol = mark_vol; }
                if bid_vol != 0.0 { entry.bid_vol = bid_vol; }
                if ask_vol != 0.0 { entry.ask_vol = ask_vol; }
            }
        }
    }
}

pub async fn build_combined_response(state: &Arc<AppState>, coin: &str) -> Option<Value> {
    let coin_upper = coin.to_uppercase();

    // Acquire all read locks and call each exchange's build_response
    let bybit_response = {
        let ticker = state.bybit_ticker.read().await;
        let spot = state.bybit_spot.read().await;
        crate::exchanges::bybit::build_response(&ticker, &spot, &coin_upper)
    };

    let okx_response = if coin_upper == "BTC" || coin_upper == "ETH" {
        let greeks = state.okx_greeks.read().await;
        let ticker = state.okx_ticker.read().await;
        let spot = state.okx_spot.read().await;
        let family = format!("{}-USD", coin_upper);
        let resp = crate::exchanges::okx::build_response(&greeks, &ticker, &spot, &family);
        // Capture spot price for bid/ask multiplication
        let spot_price = if coin_upper == "BTC" {
            spot.get("BTC-USDT").copied().unwrap_or(0.0)
        } else {
            spot.get("ETH-USDT").copied().unwrap_or(0.0)
        };
        (resp, spot_price)
    } else {
        (Value::Null, 0.0)
    };

    let deribit_response = {
        let deribit = state.deribit.read().await;
        let greeks = state.deribit_greeks.read().await;
        crate::exchanges::deribit::build_response(&deribit, &greeks, &coin_upper)
            .unwrap_or(Value::Null)
    };

    let derive_response = if coin_upper == "BTC" || coin_upper == "ETH" {
        let tickers = state.derive_tickers.read().await;
        let spot = state.derive_spot.read().await;
        crate::exchanges::derive::build_response(&tickers, &spot, &coin_upper)
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    let binance_response = {
        let binance = state.binance.read().await;
        let spot = state.binance_spot.read().await;
        crate::exchanges::binance::build_response(&binance, &spot, &coin_upper)
            .unwrap_or(Value::Null)
    };

    // Determine best spot price (max non-zero across exchanges)
    let mut best_spot = 0.0f64;
    for resp in &[&bybit_response, &okx_response.0, &deribit_response, &derive_response, &binance_response] {
        let s = resp["spotPrice"].as_f64().unwrap_or(0.0);
        if s > best_spot {
            best_spot = s;
        }
    }

    // Merge all exchanges
    let mut merged: HashMap<String, MergedContract> = HashMap::new();
    let mut forward_prices: HashMap<String, f64> = HashMap::new();

    // Bybit (bid/ask already in USD)
    if !bybit_response.is_null() {
        merge_exchange_data(&mut merged, &mut forward_prices, "bybit", &bybit_response, 1.0);
    }

    // OKX: bid/ask in BTC units, multiply by spot
    let (okx_resp, okx_spot) = okx_response;
    if !okx_resp.is_null() {
        let multiplier = if okx_spot > 0.0 { okx_spot } else { best_spot };
        merge_exchange_data(&mut merged, &mut forward_prices, "okx", &okx_resp, multiplier);
    }

    // Deribit (bid/ask already in USD)
    if !deribit_response.is_null() {
        merge_exchange_data(&mut merged, &mut forward_prices, "deribit", &deribit_response, 1.0);
    }

    // Derive (bid/ask already in USD)
    if !derive_response.is_null() {
        merge_exchange_data(&mut merged, &mut forward_prices, "derive", &derive_response, 1.0);
    }

    // Binance (bid/ask already in USD)
    if !binance_response.is_null() {
        merge_exchange_data(&mut merged, &mut forward_prices, "binance", &binance_response, 1.0);
    }

    if merged.is_empty() {
        return None;
    }

    // Group by expiry
    let mut by_expiry: HashMap<String, (Vec<Value>, Vec<Value>)> = HashMap::new();

    for (key, contract) in &merged {
        let expiry = key.split('|').next().unwrap_or("").to_string();
        let entry = by_expiry.entry(expiry).or_insert_with(|| (vec![], vec![]));
        let val = contract.to_value();
        if contract.option_type == "call" {
            entry.0.push(val);
        } else {
            entry.1.push(val);
        }
    }

    // Sort each expiry's contracts by strike
    for (calls, puts) in by_expiry.values_mut() {
        calls.sort_by(|a, b| {
            let sa = a["strike"].as_f64().unwrap_or(0.0);
            let sb = b["strike"].as_f64().unwrap_or(0.0);
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
        puts.sort_by(|a, b| {
            let sa = a["strike"].as_f64().unwrap_or(0.0);
            let sb = b["strike"].as_f64().unwrap_or(0.0);
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    let mut sorted_dates: Vec<String> = by_expiry.keys().cloned().collect();
    sorted_dates.sort();

    let mut expiration_counts = serde_json::Map::new();
    let mut data_obj = serde_json::Map::new();

    for date in &sorted_dates {
        let (calls, puts) = &by_expiry[date];
        let fwd = forward_prices.get(date).copied().unwrap_or(0.0);
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
        "spotPrice":        best_spot,
        "expirations":      sorted_dates,
        "expirationCounts": expiration_counts,
        "data":             data_obj,
    }))
}
