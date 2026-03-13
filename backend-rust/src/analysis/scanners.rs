use serde_json::{json, Value};

fn calc_break_even(theta: f64, gamma: f64) -> Option<f64> {
    if gamma <= 0.0 { return None; }
    Some((2.0 * theta.abs() / gamma).sqrt())
}

/// Get best ask for a contract. If activeExchanges is provided and contract has prices, filter to those.
fn get_ask(contract: &Value, active_exchanges: &[&str]) -> f64 {
    if !active_exchanges.is_empty() {
        if let Some(prices) = contract["prices"].as_object() {
            let mut best = 0.0f64;
            for ex in active_exchanges {
                let v = prices.get(*ex)
                    .and_then(|p| p["ask"].as_f64())
                    .unwrap_or(0.0);
                if v > 0.0 && (best == 0.0 || v < best) { best = v; }
            }
            return best;
        }
    }
    contract["bestAsk"].as_f64().filter(|&v| v > 0.0)
        .or_else(|| contract["ask"].as_f64())
        .unwrap_or(0.0)
}

fn get_bid(contract: &Value, active_exchanges: &[&str]) -> f64 {
    if !active_exchanges.is_empty() {
        if let Some(prices) = contract["prices"].as_object() {
            let mut best = 0.0f64;
            for ex in active_exchanges {
                let v = prices.get(*ex)
                    .and_then(|p| p["bid"].as_f64())
                    .unwrap_or(0.0);
                if v > best { best = v; }
            }
            return best;
        }
    }
    contract["bestBid"].as_f64().filter(|&v| v > 0.0)
        .or_else(|| contract["bid"].as_f64())
        .unwrap_or(0.0)
}

fn future_expirations(expirations: &[Value]) -> Vec<String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    expirations.iter()
        .filter_map(|v| v.as_str())
        .filter(|exp| crate::analysis::date_to_ms(exp) > now_ms)
        .map(|s| s.to_string())
        .collect()
}

pub fn compute_gamma_rows(options_data: &Value, spot: f64, active_exchanges: &[&str]) -> Vec<Value> {
    if options_data.is_null() || spot <= 0.0 { return vec![]; }
    let empty = vec![];
    let expirations = future_expirations(options_data["expirations"].as_array().unwrap_or(&empty));
    let mut results = Vec::new();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    for expiry in &expirations {
        let chain = &options_data["data"][expiry];
        let calls = chain["calls"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        let puts  = chain["puts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        if calls.is_empty() || puts.is_empty() { continue; }

        let dte = ((crate::analysis::date_to_ms(expiry) - now_ms) as f64 / 86_400_000.0).max(0.0);

        // ATM strike
        let mut all_strikes: Vec<f64> = calls.iter().chain(puts.iter())
            .filter_map(|c| c["strike"].as_f64())
            .collect();
        all_strikes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        all_strikes.dedup();
        if all_strikes.is_empty() { continue; }

        let atm = all_strikes.iter().cloned()
            .min_by(|a, b| (a - spot).abs().partial_cmp(&(b - spot).abs()).unwrap())
            .unwrap();

        // ATM straddle
        let atm_call = calls.iter().find(|c| c["strike"].as_f64() == Some(atm));
        let atm_put  = puts.iter().find(|p| p["strike"].as_f64() == Some(atm));
        if let (Some(ac), Some(ap)) = (atm_call, atm_put) {
            let call_ask = get_ask(ac, active_exchanges);
            let put_ask  = get_ask(ap, active_exchanges);
            if call_ask > 0.0 && put_ask > 0.0 {
                let gamma = ac["gamma"].as_f64().unwrap_or(0.0) + ap["gamma"].as_f64().unwrap_or(0.0);
                let theta = ac["theta"].as_f64().unwrap_or(0.0) + ap["theta"].as_f64().unwrap_or(0.0);
                if let Some(be) = calc_break_even(theta, gamma) {
                    let call_bid = get_bid(ac, active_exchanges);
                    let put_bid  = get_bid(ap, active_exchanges);
                    results.push(json!({
                        "expiry": expiry, "dte": dte, "type": "straddle",
                        "callStrike": atm, "putStrike": atm,
                        "askCost": call_ask + put_ask,
                        "bidCost": call_bid + put_bid,
                        "gamma": gamma, "theta": theta,
                        "be": be, "bePct": (be / spot) * 100.0,
                    }));
                }
            }
        }

        // OTM for strangles
        let otm_calls: Vec<&Value> = calls.iter()
            .filter(|c| {
                c["strike"].as_f64().map(|s| s > spot).unwrap_or(false) &&
                c["gamma"].as_f64().map(|g| g > 0.0).unwrap_or(false) &&
                c["theta"].as_f64().is_some()
            }).collect();
        let otm_puts: Vec<&Value> = puts.iter()
            .filter(|p| {
                p["strike"].as_f64().map(|s| s < spot).unwrap_or(false) &&
                p["gamma"].as_f64().map(|g| g > 0.0).unwrap_or(false) &&
                p["theta"].as_f64().is_some()
            }).collect();
        let has_delta = otm_calls.iter().any(|c| c["delta"].as_f64().map(|d| d != 0.0).unwrap_or(false));

        // Track best by (callStrike, putStrike) for identity check
        let mut best_long:  Option<(Value, f64, f64)> = None; // (row, be, call_strike, put_strike)
        let mut best_short: Option<(Value, f64, f64)> = None;

        const DELTA_TOL: f64 = 0.15;
        for call in &otm_calls {
            for put in &otm_puts {
                if has_delta {
                    let net_delta = call["delta"].as_f64().unwrap_or(0.0)
                                  + put["delta"].as_f64().unwrap_or(0.0);
                    if net_delta.abs() > DELTA_TOL { continue; }
                }
                let gamma = call["gamma"].as_f64().unwrap_or(0.0) + put["gamma"].as_f64().unwrap_or(0.0);
                let theta = call["theta"].as_f64().unwrap_or(0.0) + put["theta"].as_f64().unwrap_or(0.0);
                let be = match calc_break_even(theta, gamma) { Some(b) => b, None => continue };

                let call_ask = get_ask(call, active_exchanges);
                let put_ask  = get_ask(put, active_exchanges);
                if call_ask <= 0.0 || put_ask <= 0.0 { continue; }
                let call_bid = get_bid(call, active_exchanges);
                let put_bid  = get_bid(put, active_exchanges);

                let cs = call["strike"].as_f64().unwrap_or(0.0);
                let ps = put["strike"].as_f64().unwrap_or(0.0);

                let row = json!({
                    "expiry": expiry, "dte": dte, "type": "strangle",
                    "callStrike": cs, "putStrike": ps,
                    "askCost": call_ask + put_ask,
                    "bidCost": call_bid + put_bid,
                    "gamma": gamma, "theta": theta,
                    "be": be, "bePct": (be / spot) * 100.0,
                });

                if best_long.as_ref().map(|(_, b, _)| be < *b).unwrap_or(true) {
                    best_long = Some((row.clone(), be, cs * 1e6 + ps));
                }
                if best_short.as_ref().map(|(_, b, _)| be > *b).unwrap_or(true) {
                    best_short = Some((row, be, cs * 1e6 + ps));
                }
            }
        }

        if let Some((row, _, _)) = best_long.as_ref() { results.push(row.clone()); }
        // Only push bestShort if it's a different strangle (different strike pair)
        if let (Some((lr, _, lk)), Some((sr, _, sk))) = (&best_long, &best_short) {
            if (lk - sk).abs() > 0.01 {
                let _ = lr; // suppress unused warning
                results.push(sr.clone());
            }
        }
    }
    results
}

pub fn compute_vega_rows(options_data: &Value, spot: f64, active_exchanges: &[&str]) -> Vec<Value> {
    if options_data.is_null() || spot <= 0.0 { return vec![]; }
    let empty = vec![];
    let expirations = future_expirations(options_data["expirations"].as_array().unwrap_or(&empty));
    let mut results = Vec::new();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    for expiry in &expirations {
        let chain = &options_data["data"][expiry];
        let calls = chain["calls"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        let puts  = chain["puts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        if calls.is_empty() || puts.is_empty() { continue; }

        let dte = ((crate::analysis::date_to_ms(expiry) - now_ms) as f64 / 86_400_000.0).max(0.0);

        let mut all_strikes: Vec<f64> = calls.iter().chain(puts.iter())
            .filter_map(|c| c["strike"].as_f64())
            .collect();
        all_strikes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        all_strikes.dedup();
        if all_strikes.is_empty() { continue; }

        let atm = all_strikes.iter().cloned()
            .min_by(|a, b| (a - spot).abs().partial_cmp(&(b - spot).abs()).unwrap())
            .unwrap();

        let make_vega_row = |type_: &str, call: &Value, put: &Value, call_ask: f64, put_ask: f64, call_bid: f64, put_bid: f64| -> Option<Value> {
            let vega  = call["vega"].as_f64().unwrap_or(0.0) + put["vega"].as_f64().unwrap_or(0.0);
            let theta = call["theta"].as_f64().unwrap_or(0.0) + put["theta"].as_f64().unwrap_or(0.0);
            if vega <= 0.0 { return None; }
            let ask_cost = call_ask + put_ask;
            if ask_cost <= 0.0 { return None; }
            let mark_iv = (call["markVol"].as_f64().unwrap_or(0.0) + put["markVol"].as_f64().unwrap_or(0.0)) / 2.0;
            let vega_per_dollar = vega / ask_cost;
            let be_iv_move = (ask_cost / vega) * 100.0;
            Some(json!({
                "expiry": expiry, "dte": dte, "type": type_,
                "callStrike": call["strike"], "putStrike": put["strike"],
                "askCost": ask_cost, "bidCost": call_bid + put_bid,
                "vega": vega, "theta": theta, "markIV": mark_iv,
                "vegaPerDollar": vega_per_dollar, "beIVMove": be_iv_move,
            }))
        };

        // ATM straddle
        let atm_call = calls.iter().find(|c| c["strike"].as_f64() == Some(atm));
        let atm_put  = puts.iter().find(|p| p["strike"].as_f64() == Some(atm));
        if let (Some(ac), Some(ap)) = (atm_call, atm_put) {
            let call_ask = get_ask(ac, active_exchanges);
            let put_ask  = get_ask(ap, active_exchanges);
            if call_ask > 0.0 && put_ask > 0.0 {
                if let Some(row) = make_vega_row("straddle", ac, ap, call_ask, put_ask,
                    get_bid(ac, active_exchanges), get_bid(ap, active_exchanges)) {
                    results.push(row);
                }
            }
        }

        // OTM for strangles
        let otm_calls: Vec<&Value> = calls.iter()
            .filter(|c| {
                c["strike"].as_f64().map(|s| s > spot).unwrap_or(false) &&
                c["vega"].as_f64().map(|v| v > 0.0).unwrap_or(false)
            }).collect();
        let otm_puts: Vec<&Value> = puts.iter()
            .filter(|p| {
                p["strike"].as_f64().map(|s| s < spot).unwrap_or(false) &&
                p["vega"].as_f64().map(|v| v > 0.0).unwrap_or(false)
            }).collect();
        let has_delta = otm_calls.iter().any(|c| c["delta"].as_f64().map(|d| d != 0.0).unwrap_or(false));

        let mut best_long:  Option<(Value, f64, f64)> = None; // (row, vegaPerDollar, key)
        let mut best_short: Option<(Value, f64, f64)> = None; // (row, beIVMove, key)

        const DELTA_TOL: f64 = 0.15;
        for call in &otm_calls {
            for put in &otm_puts {
                if has_delta {
                    let net = call["delta"].as_f64().unwrap_or(0.0) + put["delta"].as_f64().unwrap_or(0.0);
                    if net.abs() > DELTA_TOL { continue; }
                }
                let call_ask = get_ask(call, active_exchanges);
                let put_ask  = get_ask(put, active_exchanges);
                if call_ask <= 0.0 || put_ask <= 0.0 { continue; }
                let row = match make_vega_row("strangle", call, put, call_ask, put_ask,
                    get_bid(call, active_exchanges), get_bid(put, active_exchanges)) {
                    Some(r) => r,
                    None => continue,
                };
                let vpd     = row["vegaPerDollar"].as_f64().unwrap_or(0.0);
                let be_move = row["beIVMove"].as_f64().unwrap_or(0.0);
                let cs = call["strike"].as_f64().unwrap_or(0.0);
                let ps = put["strike"].as_f64().unwrap_or(0.0);
                let key = cs * 1e6 + ps;

                if best_long.as_ref().map(|(_, v, _)| vpd > *v).unwrap_or(true) {
                    best_long = Some((row.clone(), vpd, key));
                }
                if best_short.as_ref().map(|(_, b, _)| be_move > *b).unwrap_or(true) {
                    best_short = Some((row, be_move, key));
                }
            }
        }

        if let Some((row, _, _)) = best_long.as_ref() { results.push(row.clone()); }
        if let (Some((_, _, lk)), Some((sr, _, sk))) = (&best_long, &best_short) {
            if (lk - sk).abs() > 0.01 {
                results.push(sr.clone());
            }
        }
    }
    results
}
