use serde_json::{json, Value};

const TAKER_FEE: f64 = 0.0003;

fn fee_cap(exchange: Option<&str>) -> f64 {
    match exchange {
        Some("bybit")   => 0.07,
        Some("okx")     => 0.07,
        Some("deribit") => 0.125,
        _               => 0.07,
    }
}

fn apply_fee(price: f64, side: &str, exchange: Option<&str>, spot: f64) -> f64 {
    if price == 0.0 { return 0.0; }
    let cap = fee_cap(exchange);
    let fee = (TAKER_FEE * spot).min(cap * price);
    if side == "buy" { price + fee } else { price - fee }
}

fn calc_apr(profit: f64, collateral: f64, days: f64) -> f64 {
    if collateral <= 0.0 || days <= 0.0 { return 0.0; }
    (profit / collateral) * (365.0 / days) * 100.0
}

/// Pick best futures hedge: dated future within 10% of option DTE, else nearest perp.
fn pick_hedge<'a>(options_expiry: &str, futures: &'a [Value], now_ms: i64) -> Option<(f64, &'a str, bool)> {
    let expiry_ms: i64 = options_expiry.split('T').next()
        .map(|d| crate::analysis::date_to_ms(d))
        .unwrap_or_else(|| crate::analysis::date_to_ms(options_expiry));
    let opts_days = (expiry_ms - now_ms) as f64 / 86_400_000.0;
    if opts_days <= 0.0 { return None; }

    let threshold = opts_days * 0.10;
    let mut best_dated: Option<(f64, &str)> = None;
    let mut best_dist = f64::INFINITY;

    for f in futures {
        let is_perp = f["isPerp"].as_bool().unwrap_or(true);
        let mark = f["markPrice"].as_f64().unwrap_or(0.0);
        if is_perp || mark <= 0.0 { continue; }
        let fexp = f["expiry"].as_str().unwrap_or("");
        if fexp.is_empty() { continue; }
        let fut_ms = crate::analysis::date_to_ms(fexp);
        let fut_days = (fut_ms - now_ms) as f64 / 86_400_000.0;
        let dist = (fut_days - opts_days).abs();
        if dist < threshold && dist < best_dist {
            best_dist = dist;
            best_dated = Some((mark, f["exchange"].as_str().unwrap_or("")));
        }
    }
    if let Some((price, ex)) = best_dated {
        return Some((price, ex, false));
    }
    // Fallback: first perp with a price
    for f in futures {
        let is_perp = f["isPerp"].as_bool().unwrap_or(false);
        let mark = f["markPrice"].as_f64().unwrap_or(0.0);
        if is_perp && mark > 0.0 {
            return Some((mark, f["exchange"].as_str().unwrap_or(""), true));
        }
    }
    None
}

/// Returns (price, exchange_or_null)
fn get_price<'a>(contract: &'a Value, side: &str) -> (f64, Option<&'a str>) {
    if side == "buy" {
        let val = contract["bestAsk"].as_f64()
            .filter(|&v| v > 0.0)
            .or_else(|| contract["ask"].as_f64())
            .unwrap_or(0.0);
        let ex = contract["bestAskEx"].as_str();
        (val, ex)
    } else {
        let val = contract["bestBid"].as_f64()
            .filter(|&v| v > 0.0)
            .or_else(|| contract["bid"].as_f64())
            .unwrap_or(0.0);
        let ex = contract["bestBidEx"].as_str();
        (val, ex)
    }
}

pub fn find_box_spreads(response: &Value, spot: f64, min_profit: f64) -> Vec<Value> {
    let mut results = Vec::new();
    let lo = spot * 0.6;
    let hi = spot * 1.4;

    let data = match response["data"].as_object() {
        Some(d) => d,
        None => return results,
    };

    for (expiry, chain_data) in data {
        let empty = vec![];
        let calls = chain_data["calls"].as_array().unwrap_or(&empty);
        let puts  = chain_data["puts"].as_array().unwrap_or(&empty);

        // Build maps: strike -> contract (only if has a bid or ask)
        let calls_map: std::collections::HashMap<i64, &Value> = calls.iter()
            .filter(|c| {
                c["bestBid"].as_f64().map(|v| v > 0.0).unwrap_or(false) ||
                c["bestAsk"].as_f64().map(|v| v > 0.0).unwrap_or(false)
            })
            .filter_map(|c| c["strike"].as_f64().map(|s| ((s * 100.0).round() as i64, c)))
            .collect();
        let puts_map: std::collections::HashMap<i64, &Value> = puts.iter()
            .filter(|p| {
                p["bestBid"].as_f64().map(|v| v > 0.0).unwrap_or(false) ||
                p["bestAsk"].as_f64().map(|v| v > 0.0).unwrap_or(false)
            })
            .filter_map(|p| p["strike"].as_f64().map(|s| ((s * 100.0).round() as i64, p)))
            .collect();

        let mut strikes: Vec<f64> = calls_map.keys().chain(puts_map.keys())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .map(|&k| k as f64 / 100.0)
            .filter(|&s| s >= lo && s <= hi)
            .collect();
        strikes.sort_by(|a, b| a.partial_cmp(b).unwrap());

        for i in 0..strikes.len() {
            for j in (i + 1)..strikes.len() {
                let (k1, k2) = (strikes[i], strikes[j]);
                let k1_key = (k1 * 100.0).round() as i64;
                let k2_key = (k2 * 100.0).round() as i64;
                let (c1, c2, p1, p2) = match (
                    calls_map.get(&k1_key), calls_map.get(&k2_key),
                    puts_map.get(&k1_key),  puts_map.get(&k2_key),
                ) {
                    (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
                    _ => continue,
                };
                let box_value = k2 - k1;

                // Long box: buy C(K1) ask, sell C(K2) bid, buy P(K2) ask, sell P(K1) bid
                let (lc1a, lc1a_ex) = get_price(c1, "buy");
                let (lc2b, lc2b_ex) = get_price(c2, "sell");
                let (lp2a, lp2a_ex) = get_price(p2, "buy");
                let (lp1b, lp1b_ex) = get_price(p1, "sell");
                if lc1a > 0.0 && lc2b > 0.0 && lp2a > 0.0 && lp1b > 0.0 {
                    let cost = apply_fee(lc1a, "buy",  lc1a_ex, spot)
                             - apply_fee(lc2b, "sell", lc2b_ex, spot)
                             + apply_fee(lp2a, "buy",  lp2a_ex, spot)
                             - apply_fee(lp1b, "sell", lp1b_ex, spot);
                    let profit = box_value - cost;
                    if profit > min_profit {
                        results.push(json!({
                            "expiry": expiry, "k1": k1, "k2": k2, "type": "long",
                            "profit": profit, "cost": cost, "boxValue": box_value,
                            "legs": [
                                {"action":"buy",  "type":"call","strike":k1,"price":lc1a,"exchange":lc1a_ex},
                                {"action":"sell", "type":"call","strike":k2,"price":lc2b,"exchange":lc2b_ex},
                                {"action":"buy",  "type":"put", "strike":k2,"price":lp2a,"exchange":lp2a_ex},
                                {"action":"sell", "type":"put", "strike":k1,"price":lp1b,"exchange":lp1b_ex},
                            ],
                        }));
                    }
                }

                // Short box: sell C(K1) bid, buy C(K2) ask, sell P(K2) bid, buy P(K1) ask
                let (sc1b, sc1b_ex) = get_price(c1, "sell");
                let (sc2a, sc2a_ex) = get_price(c2, "buy");
                let (sp2b, sp2b_ex) = get_price(p2, "sell");
                let (sp1a, sp1a_ex) = get_price(p1, "buy");
                if sc1b > 0.0 && sc2a > 0.0 && sp2b > 0.0 && sp1a > 0.0 {
                    let revenue = apply_fee(sc1b, "sell", sc1b_ex, spot)
                                - apply_fee(sc2a, "buy",  sc2a_ex, spot)
                                + apply_fee(sp2b, "sell", sp2b_ex, spot)
                                - apply_fee(sp1a, "buy",  sp1a_ex, spot);
                    let profit = revenue - box_value;
                    if profit > min_profit {
                        results.push(json!({
                            "expiry": expiry, "k1": k1, "k2": k2, "type": "short",
                            "profit": profit, "cost": revenue, "boxValue": box_value,
                            "legs": [
                                {"action":"sell","type":"call","strike":k1,"price":sc1b,"exchange":sc1b_ex},
                                {"action":"buy", "type":"call","strike":k2,"price":sc2a,"exchange":sc2a_ex},
                                {"action":"sell","type":"put", "strike":k2,"price":sp2b,"exchange":sp2b_ex},
                                {"action":"buy", "type":"put", "strike":k1,"price":sp1a,"exchange":sp1a_ex},
                            ],
                        }));
                    }
                }
            }
        }
    }
    results
}

pub fn find_vertical_arbs(response: &Value, spot: f64, min_profit: f64) -> Vec<Value> {
    let mut results = Vec::new();
    let lo = spot * 0.6;
    let hi = spot * 1.4;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let data = match response["data"].as_object() { Some(d) => d, None => return results };

    for (expiry, chain_data) in data {
        let days = ((crate::analysis::date_to_ms(expiry) - now_ms) as f64 / 86_400_000.0).max(1.0);
        let empty = vec![];

        for (opt_type, contracts_val) in [("call", &chain_data["calls"]), ("put", &chain_data["puts"])] {
            let contracts = contracts_val.as_array().unwrap_or(&empty);
            let mut sorted: Vec<&Value> = contracts.iter()
                .filter(|c| c["strike"].as_f64().map(|s| s >= lo && s <= hi).unwrap_or(false))
                .collect();
            sorted.sort_by(|a, b| {
                a["strike"].as_f64().unwrap_or(0.0)
                    .partial_cmp(&b["strike"].as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            for i in 0..sorted.len().saturating_sub(1) {
                let c_low  = sorted[i];
                let c_high = sorted[i + 1];

                if opt_type == "call" {
                    let (b_ask, b_ex) = get_price(c_low,  "buy");
                    let (s_bid, s_ex) = get_price(c_high, "sell");
                    if b_ask <= 0.0 || s_bid <= 0.0 { continue; }
                    let paid     = apply_fee(b_ask, "buy",  b_ex, spot);
                    let received = apply_fee(s_bid, "sell", s_ex, spot);
                    let profit   = received - paid;
                    if profit > min_profit {
                        results.push(json!({
                            "strategy": "call_monotonicity", "expiry": expiry,
                            "profit": profit, "apr": calc_apr(profit, b_ask, days), "collateral": b_ask,
                            "legs": [
                                {"action":"buy",  "type":"call","strike":c_low["strike"], "expiry":expiry,"qty":1,"price":b_ask,"exchange":b_ex},
                                {"action":"sell", "type":"call","strike":c_high["strike"],"expiry":expiry,"qty":1,"price":s_bid,"exchange":s_ex},
                            ],
                        }));
                    }
                } else {
                    let (s_bid, s_ex) = get_price(c_low,  "sell");
                    let (b_ask, b_ex) = get_price(c_high, "buy");
                    if s_bid <= 0.0 || b_ask <= 0.0 { continue; }
                    let received = apply_fee(s_bid, "sell", s_ex, spot);
                    let paid     = apply_fee(b_ask, "buy",  b_ex, spot);
                    let profit   = received - paid;
                    if profit > min_profit {
                        results.push(json!({
                            "strategy": "put_monotonicity", "expiry": expiry,
                            "profit": profit, "apr": calc_apr(profit, b_ask, days), "collateral": b_ask,
                            "legs": [
                                {"action":"sell","type":"put","strike":c_low["strike"], "expiry":expiry,"qty":1,"price":s_bid,"exchange":s_ex},
                                {"action":"buy", "type":"put","strike":c_high["strike"],"expiry":expiry,"qty":1,"price":b_ask,"exchange":b_ex},
                            ],
                        }));
                    }
                }
            }
        }
    }
    results
}

pub fn find_butterfly_arbs(response: &Value, spot: f64, min_profit: f64) -> Vec<Value> {
    let mut results = Vec::new();
    let lo = spot * 0.6;
    let hi = spot * 1.4;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let data = match response["data"].as_object() { Some(d) => d, None => return results };

    for (expiry, chain_data) in data {
        let days = ((crate::analysis::date_to_ms(expiry) - now_ms) as f64 / 86_400_000.0).max(1.0);
        let empty = vec![];

        for (opt_type, contracts_val) in [("call", &chain_data["calls"]), ("put", &chain_data["puts"])] {
            let contracts = contracts_val.as_array().unwrap_or(&empty);
            let mut sorted: Vec<&Value> = contracts.iter()
                .filter(|c| c["strike"].as_f64().map(|s| s >= lo && s <= hi).unwrap_or(false))
                .collect();
            sorted.sort_by(|a, b| {
                a["strike"].as_f64().unwrap_or(0.0)
                    .partial_cmp(&b["strike"].as_f64().unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            for i in 0..sorted.len().saturating_sub(2) {
                let (c1, c2, c3) = (sorted[i], sorted[i + 1], sorted[i + 2]);
                let left_gap  = c2["strike"].as_f64().unwrap_or(0.0) - c1["strike"].as_f64().unwrap_or(0.0);
                let right_gap = c3["strike"].as_f64().unwrap_or(0.0) - c2["strike"].as_f64().unwrap_or(0.0);
                if left_gap <= 0.0 || (left_gap - right_gap).abs() / left_gap > 0.05 { continue; }

                let (w1, w1_ex) = get_price(c1, "buy");
                let (m2, m2_ex) = get_price(c2, "sell");
                let (w3, w3_ex) = get_price(c3, "buy");
                if w1 <= 0.0 || m2 <= 0.0 || w3 <= 0.0 { continue; }

                let paid1 = apply_fee(w1, "buy",  w1_ex, spot);
                let recv2 = apply_fee(m2, "sell", m2_ex, spot) * 2.0;
                let paid3 = apply_fee(w3, "buy",  w3_ex, spot);
                let profit = -(paid1 - recv2 + paid3);
                if profit > min_profit {
                    let strategy = if opt_type == "call" { "call_butterfly" } else { "put_butterfly" };
                    results.push(json!({
                        "strategy": strategy, "expiry": expiry,
                        "profit": profit, "apr": calc_apr(profit, left_gap, days), "collateral": left_gap,
                        "legs": [
                            {"action":"buy", "type":opt_type,"strike":c1["strike"],"expiry":expiry,"qty":1,"price":w1,"exchange":w1_ex},
                            {"action":"sell","type":opt_type,"strike":c2["strike"],"expiry":expiry,"qty":2,"price":m2,"exchange":m2_ex},
                            {"action":"buy", "type":opt_type,"strike":c3["strike"],"expiry":expiry,"qty":1,"price":w3,"exchange":w3_ex},
                        ],
                    }));
                }
            }
        }
    }
    results
}

pub fn find_calendar_arbs(response: &Value, spot: f64, min_profit: f64) -> Vec<Value> {
    let mut results = Vec::new();
    let lo = spot * 0.6;
    let hi = spot * 1.4;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let data = match response["data"].as_object() { Some(d) => d, None => return results };

    // Group by (strike, optType)
    let mut groups: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    let empty = vec![];
    for (expiry, chain_data) in data {
        for (opt_type, contracts_val) in [("call", &chain_data["calls"]), ("put", &chain_data["puts"])] {
            for c in contracts_val.as_array().unwrap_or(&empty) {
                let strike = c["strike"].as_f64().unwrap_or(0.0);
                if strike < lo || strike > hi { continue; }
                let key = format!("{}|{}", (strike * 100.0).round() as i64, opt_type);
                let mut entry = c.clone();
                entry["expiry"] = Value::String(expiry.clone());
                groups.entry(key).or_default().push(entry);
            }
        }
    }

    for (key, mut entries) in groups {
        if entries.len() < 2 { continue; }
        let opt_type = key.split('|').nth(1).unwrap_or("call");
        entries.sort_by(|a, b| {
            let ea = crate::analysis::date_to_ms(a["expiry"].as_str().unwrap_or(""));
            let eb = crate::analysis::date_to_ms(b["expiry"].as_str().unwrap_or(""));
            ea.cmp(&eb)
        });

        for i in 0..entries.len().saturating_sub(1) {
            let near = &entries[i];
            let far  = &entries[i + 1];
            let near_exp = near["expiry"].as_str().unwrap_or("");
            let far_exp  = far["expiry"].as_str().unwrap_or("");

            let (bid_near, bid_near_ex) = get_price(near, "sell");
            let (ask_far,  ask_far_ex)  = get_price(far,  "buy");
            if bid_near <= 0.0 || ask_far <= 0.0 { continue; }

            let received = apply_fee(bid_near, "sell", bid_near_ex, spot);
            let paid     = apply_fee(ask_far,  "buy",  ask_far_ex,  spot);
            let profit   = received - paid;
            if profit > min_profit {
                let days = ((crate::analysis::date_to_ms(near_exp) - now_ms) as f64 / 86_400_000.0).max(1.0);
                let near_strike = near["strike"].as_f64().unwrap_or(0.0);
                results.push(json!({
                    "strategy": "calendar_arb", "expiry": near_exp,
                    "profit": profit, "apr": calc_apr(profit, ask_far, days), "collateral": ask_far,
                    "legs": [
                        {"action":"sell","type":opt_type,"strike":near_strike,"expiry":near_exp,"qty":1,"price":bid_near,"exchange":bid_near_ex},
                        {"action":"buy", "type":opt_type,"strike":near_strike,"expiry":far_exp, "qty":1,"price":ask_far, "exchange":ask_far_ex},
                    ],
                }));
            }
        }
    }
    results
}

pub fn find_pcp_arbs(response: &Value, spot: f64, futures: &[Value], min_profit: f64) -> Vec<Value> {
    let mut results = Vec::new();
    let lo = spot * 0.6;
    let hi = spot * 1.4;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let data = match response["data"].as_object() { Some(d) => d, None => return results };

    for (expiry, chain_data) in data {
        let fwd = chain_data["forwardPrice"].as_f64().filter(|&v| v > 0.0).unwrap_or(spot);
        let hedge = pick_hedge(expiry, futures, now_ms);
        let hedge_price = hedge.map(|(p, _, _)| p).unwrap_or(fwd);
        let hedge_ex    = hedge.map(|(_, ex, _)| ex);
        let days = ((crate::analysis::date_to_ms(expiry) - now_ms) as f64 / 86_400_000.0).max(1.0);

        let empty = vec![];
        let calls_map: std::collections::HashMap<i64, &Value> = chain_data["calls"].as_array().unwrap_or(&empty)
            .iter()
            .filter(|c| c["strike"].as_f64().map(|s| s >= lo && s <= hi).unwrap_or(false))
            .filter_map(|c| c["strike"].as_f64().map(|s| ((s * 100.0).round() as i64, c)))
            .collect();
        let puts_map: std::collections::HashMap<i64, &Value> = chain_data["puts"].as_array().unwrap_or(&empty)
            .iter()
            .filter(|p| p["strike"].as_f64().map(|s| s >= lo && s <= hi).unwrap_or(false))
            .filter_map(|p| p["strike"].as_f64().map(|s| ((s * 100.0).round() as i64, p)))
            .collect();

        for (&strike_key, call) in &calls_map {
            let put = match puts_map.get(&strike_key) { Some(p) => p, None => continue };
            let strike = strike_key as f64 / 100.0;
            let theoretical = fwd - strike;

            // Conversion: sell C + buy P (+ buy future)
            let (call_bid, call_bid_ex) = get_price(call, "sell");
            let (put_ask,  put_ask_ex)  = get_price(put,  "buy");
            if call_bid > 0.0 && put_ask > 0.0 {
                let received = apply_fee(call_bid, "sell", call_bid_ex, spot);
                let paid     = apply_fee(put_ask,  "buy",  put_ask_ex,  spot);
                let profit   = (received - paid) - theoretical;
                if profit > min_profit {
                    let collateral = 0.1 * spot + call_bid;
                    let hedge_exchange = hedge_ex.unwrap_or(call_bid_ex.unwrap_or(""));
                    results.push(json!({
                        "strategy": "pcp_conversion", "expiry": expiry,
                        "profit": profit, "apr": calc_apr(profit, collateral, days), "collateral": collateral,
                        "legs": [
                            {"action":"sell", "type":"call",   "strike":strike,"expiry":expiry,"qty":1,"price":call_bid,"exchange":call_bid_ex},
                            {"action":"buy",  "type":"put",    "strike":strike,"expiry":expiry,"qty":1,"price":put_ask, "exchange":put_ask_ex},
                            {"action":"buy",  "type":"future", "strike":0,     "expiry":expiry,"qty":1,"price":hedge_price,"exchange":hedge_exchange},
                        ],
                    }));
                }
            }

            // Reversal: buy C + sell P (+ sell future)
            let (call_ask, call_ask_ex) = get_price(call, "buy");
            let (put_bid,  put_bid_ex)  = get_price(put,  "sell");
            if call_ask > 0.0 && put_bid > 0.0 {
                let paid     = apply_fee(call_ask, "buy",  call_ask_ex, spot);
                let received = apply_fee(put_bid,  "sell", put_bid_ex,  spot);
                let profit   = theoretical - (paid - received);
                if profit > min_profit {
                    let collateral = 0.1 * spot + put_bid;
                    let hedge_exchange = hedge_ex.unwrap_or(call_ask_ex.unwrap_or(""));
                    results.push(json!({
                        "strategy": "pcp_reversal", "expiry": expiry,
                        "profit": profit, "apr": calc_apr(profit, collateral, days), "collateral": collateral,
                        "legs": [
                            {"action":"buy",  "type":"call",   "strike":strike,"expiry":expiry,"qty":1,"price":call_ask,"exchange":call_ask_ex},
                            {"action":"sell", "type":"put",    "strike":strike,"expiry":expiry,"qty":1,"price":put_bid, "exchange":put_bid_ex},
                            {"action":"sell", "type":"future", "strike":0,     "expiry":expiry,"qty":1,"price":hedge_price,"exchange":hedge_exchange},
                        ],
                    }));
                }
            }
        }
    }
    results
}

pub fn find_all_arbs(response: &Value, spot: f64, futures: &[Value]) -> Vec<Value> {
    let mut all = find_vertical_arbs(response, spot, 0.0);
    all.extend(find_butterfly_arbs(response, spot, 0.0));
    all.extend(find_calendar_arbs(response, spot, 0.0));
    all.extend(find_pcp_arbs(response, spot, futures, 0.0));
    all
}
