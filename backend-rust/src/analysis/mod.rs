pub mod svi;

use serde_json::{json, Value};

const MS_PER_YEAR: f64 = 365.25 * 24.0 * 3600.0 * 1000.0;

/// "YYYY-MM-DD" → Unix ms at T08:00:00Z (same as JS `new Date(exp + 'T08:00:00Z').getTime()`)
pub fn date_to_ms(date: &str) -> i64 {
    let parts: Vec<i64> = date.split('-')
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() != 3 { return 0; }
    let (y, m, d) = (parts[0], parts[1], parts[2]);
    // Hinnant days_from_civil
    let (y1, m1) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y1.div_euclid(400);
    let yoe = y1 - era * 400;
    let doy = (153 * m1 + 2) / 5 + d - 1;
    let doe = 365 * yoe + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    (days * 86400 + 8 * 3600) * 1000
}

/// "YYYY-MM-DD" → "Mar 15" (UTC, same as JS `toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone:'UTC'})`)
pub fn date_label(date: &str) -> String {
    const MONTHS: &[&str] = &["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let parts: Vec<u32> = date.split('-').filter_map(|s| s.parse().ok()).collect();
    if parts.len() != 3 { return date.to_string(); }
    let m = (parts[1] as usize).saturating_sub(1);
    let mon = MONTHS.get(m).copied().unwrap_or("?");
    format!("{} {}", mon, parts[2])
}

fn resolve_bid(contract: &Value) -> f64 {
    let b = contract["bid"].as_f64().unwrap_or(0.0);
    if b > 0.0 { return b; }
    let best = contract["bestBid"].as_f64().unwrap_or(0.0);
    if best > 0.0 { return best; }
    if let Some(prices) = contract["prices"].as_object() {
        let bids: Vec<f64> = prices.values()
            .filter_map(|p| p["bid"].as_f64())
            .filter(|&v| v > 0.0)
            .collect();
        if !bids.is_empty() { return bids.iter().cloned().fold(f64::NEG_INFINITY, f64::max); }
    }
    0.0
}

fn resolve_ask(contract: &Value) -> f64 {
    let a = contract["ask"].as_f64().unwrap_or(0.0);
    if a > 0.0 { return a; }
    let best = contract["bestAsk"].as_f64().unwrap_or(0.0);
    if best > 0.0 { return best; }
    if let Some(prices) = contract["prices"].as_object() {
        let asks: Vec<f64> = prices.values()
            .filter_map(|p| p["ask"].as_f64())
            .filter(|&v| v > 0.0)
            .collect();
        if !asks.is_empty() { return asks.iter().cloned().fold(f64::INFINITY, f64::min); }
    }
    0.0
}

fn compute_atm_bbo_spread(expirations: &[String], response: &Value, spot: f64) -> Vec<Value> {
    let mut results = Vec::new();
    for exp in expirations {
        let chain = &response["data"][exp];
        if chain.is_null() { continue; }

        let mut strikes: Vec<f64> = Vec::new();
        for c in chain["calls"].as_array().unwrap_or(&vec![]) {
            if let Some(s) = c["strike"].as_f64() { strikes.push(s); }
        }
        for p in chain["puts"].as_array().unwrap_or(&vec![]) {
            if let Some(s) = p["strike"].as_f64() { strikes.push(s); }
        }
        strikes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        strikes.dedup();
        if strikes.is_empty() { continue; }

        let atm = strikes.iter().cloned()
            .min_by(|a, b| (a - spot).abs().partial_cmp(&(b - spot).abs()).unwrap())
            .unwrap();

        let empty = vec![];
        let atm_call = chain["calls"].as_array().unwrap_or(&empty).iter()
            .find(|c| c["strike"].as_f64() == Some(atm));
        let atm_put = chain["puts"].as_array().unwrap_or(&empty).iter()
            .find(|p| p["strike"].as_f64() == Some(atm));

        let label = date_label(exp);

        let spreads: Vec<(f64, f64)> = [atm_call, atm_put].iter()
            .filter_map(|opt| *opt)
            .filter_map(|contract| {
                let bid = resolve_bid(contract);
                let ask = resolve_ask(contract);
                if bid <= 0.0 || ask <= 0.0 || ask < bid { return None; }
                let mid = (bid + ask) / 2.0;
                if mid <= 0.0 { return None; }
                Some((ask - bid, (ask - bid) / mid * 100.0))
            })
            .collect();

        if spreads.is_empty() { continue; }
        let n = spreads.len() as f64;
        let avg_usd = spreads.iter().map(|(u, _)| u).sum::<f64>() / n;
        let avg_pct = spreads.iter().map(|(_, p)| p).sum::<f64>() / n;

        results.push(json!({
            "exp":       exp,
            "label":     label,
            "spreadUsd": (avg_usd * 100.0).round() / 100.0,
            "spreadPct": (avg_pct * 100.0).round() / 100.0,
        }));
    }
    results
}

/// Unique strikes (OTM only) → sorted log-moneyness bucket centers
fn make_bucket_centers(expirations: &[String], response: &Value, spot: f64) -> Vec<f64> {
    let mut k_set: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    for exp in expirations {
        let chain = &response["data"][exp];
        let empty = vec![];
        for c in chain["calls"].as_array().unwrap_or(&empty) {
            let strike = c["strike"].as_f64().unwrap_or(0.0);
            let mv = c["markVol"].as_f64().unwrap_or(0.0);
            if strike < spot || mv <= 0.0 { continue; }
            let k = (f64::ln(strike / spot) * 1e4).round() as i64;
            k_set.insert(k);
        }
        for p in chain["puts"].as_array().unwrap_or(&empty) {
            let strike = p["strike"].as_f64().unwrap_or(0.0);
            let mv = p["markVol"].as_f64().unwrap_or(0.0);
            if strike > spot || mv <= 0.0 { continue; }
            let k = (f64::ln(strike / spot) * 1e4).round() as i64;
            k_set.insert(k);
        }
    }
    k_set.iter().map(|&k| k as f64 / 1e4).collect()
}

fn format_bucket_label(center: f64, decimals: usize) -> String {
    if center.abs() < 1e-9 { return "ATM".into(); }
    let pct = (center.exp() - 1.0) * 100.0;
    let sign = if pct >= 0.0 { "+" } else { "" };
    format!("{}{:.prec$}%", sign, pct, prec = decimals)
}

fn format_unique_bucket_labels(centers: &[f64]) -> Vec<String> {
    let mut decimals: Vec<usize> = centers.iter()
        .map(|&c| if ((c.exp() - 1.0) * 100.0).abs() >= 2.0 { 0 } else { 1 })
        .collect();

    for _ in 0..6 {
        let labels: Vec<String> = centers.iter().zip(&decimals)
            .map(|(&c, &d)| format_bucket_label(c, d))
            .collect();

        // Find duplicates
        let mut seen: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
        for (i, label) in labels.iter().enumerate() {
            seen.entry(label.as_str()).or_default().push(i);
        }
        let dup_indices: Vec<usize> = seen.into_values()
            .filter(|idxs| idxs.len() > 1 && labels[idxs[0]] != "ATM")
            .flatten()
            .collect();

        if dup_indices.is_empty() { return labels; }
        for i in dup_indices {
            decimals[i] = (decimals[i] + 1).min(4);
        }
    }

    centers.iter().map(|&c| format_bucket_label(c, 4)).collect()
}

fn compute_raw_surface(expirations: &[String], response: &Value, spot: f64, now_ms: i64) -> Value {
    let centers = make_bucket_centers(expirations, response, spot);
    if centers.is_empty() {
        return json!({ "expiries": [], "buckets": [], "cells": [] });
    }
    let labels = format_unique_bucket_labels(&centers);

    let buckets: Vec<Value> = centers.iter().zip(&labels).map(|(&c, l)| json!({
        "key":          c,
        "label":        l,
        "moneynessPct": ((c.exp() - 1.0) * 100.0 * 10.0).round() / 10.0,
    })).collect();

    let mut cells: Vec<Value> = Vec::new();
    let mut expiry_rows: Vec<Value> = Vec::new();

    for exp in expirations {
        let chain = &response["data"][exp];
        if chain.is_null() { continue; }

        let expiry_ms = date_to_ms(exp);
        let t = ((expiry_ms - now_ms) as f64 / MS_PER_YEAR).max(1e-4);
        let dte = (t * 365.25).round() as i64;
        let label = date_label(exp);

        // Map: bucket_key_i64 → (iv_sum, count, min_strike, max_strike, has_call, has_put)
        let mut bucket_map: std::collections::HashMap<i64, (f64, usize, f64, f64, bool, bool)> =
            centers.iter().map(|&c| ((c * 1e4).round() as i64, (0.0, 0, f64::INFINITY, f64::NEG_INFINITY, false, false))).collect();

        for c in chain["calls"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let strike = c["strike"].as_f64().unwrap_or(0.0);
            let mv = c["markVol"].as_f64().unwrap_or(0.0);
            if strike < spot || mv <= 0.0 { continue; }
            let k = f64::ln(strike / spot);
            let nearest_key = centers.iter()
                .min_by(|&&a, &&b| (a - k).abs().partial_cmp(&(b - k).abs()).unwrap())
                .map(|&c| (c * 1e4).round() as i64)
                .unwrap();
            if let Some(e) = bucket_map.get_mut(&nearest_key) {
                e.0 += mv * 100.0; e.1 += 1;
                e.2 = e.2.min(strike); e.3 = e.3.max(strike);
                e.4 = true;
            }
        }

        for p in chain["puts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let strike = p["strike"].as_f64().unwrap_or(0.0);
            let mv = p["markVol"].as_f64().unwrap_or(0.0);
            if strike > spot || mv <= 0.0 { continue; }
            let k = f64::ln(strike / spot);
            let nearest_key = centers.iter()
                .min_by(|&&a, &&b| (a - k).abs().partial_cmp(&(b - k).abs()).unwrap())
                .map(|&c| (c * 1e4).round() as i64)
                .unwrap();
            if let Some(e) = bucket_map.get_mut(&nearest_key) {
                e.0 += mv * 100.0; e.1 += 1;
                e.2 = e.2.min(strike); e.3 = e.3.max(strike);
                e.5 = true;
            }
        }

        let mut cell_count = 0;
        for (&center_key, &(iv_sum, count, min_s, max_s, has_call, has_put)) in &bucket_map {
            if count == 0 { continue; }
            let center = center_key as f64 / 1e4;
            let bucket_label = labels.iter().zip(centers.iter())
                .find(|(_, &c)| ((c * 1e4).round() as i64) == center_key)
                .map(|(l, _)| l.as_str())
                .unwrap_or("");
            let opt_types: Vec<&str> = [("call", has_call), ("put", has_put)]
                .iter().filter(|(_, v)| *v).map(|(s, _)| *s).collect();
            cell_count += 1;
            cells.push(json!({
                "exp":          exp,
                "label":        label,
                "dte":          dte,
                "bucketKey":    center,
                "bucketLabel":  bucket_label,
                "moneynessPct": ((center.exp() - 1.0) * 100.0 * 10.0).round() / 10.0,
                "avgMarkIV":    ((iv_sum / count as f64) * 10.0).round() / 10.0,
                "count":        count,
                "minStrike":    min_s,
                "maxStrike":    max_s,
                "optionTypes":  opt_types,
            }));
        }

        if cell_count > 0 {
            expiry_rows.push(json!({ "exp": exp, "label": label, "dte": dte }));
        }
    }

    json!({ "expiries": expiry_rows, "buckets": buckets, "cells": cells })
}

/// Main analysis computation. `response` is the exchange options chain JSON.
pub fn compute_analysis(response: &Value, spot: f64) -> Option<Value> {
    if response.is_null() || spot <= 0.0 { return None; }

    let expirations_raw = response["expirations"].as_array()?;
    if expirations_raw.is_empty() { return None; }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Filter to future expirations only
    let expirations: Vec<String> = expirations_raw.iter()
        .filter_map(|v| v.as_str())
        .filter(|exp| date_to_ms(exp) > now_ms)
        .map(|s| s.to_string())
        .collect();

    if expirations.is_empty() { return None; }

    let raw_surface = compute_raw_surface(&expirations, response, spot, now_ms);

    // SVI fits: keep native structs for internal use, convert to JSON only at end
    let mut fits_internal: std::collections::HashMap<String, Option<svi::SviFitResult>> =
        std::collections::HashMap::new();
    for exp in &expirations {
        let chain = &response["data"][exp];
        let calls = chain["calls"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        let puts  = chain["puts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
        if calls.is_empty() || puts.is_empty() {
            fits_internal.insert(exp.clone(), None);
            continue;
        }

        let expiry_ms = date_to_ms(exp);
        let t = ((expiry_ms - now_ms) as f64 / MS_PER_YEAR).max(1e-4);

        let mut ks: Vec<f64> = Vec::new();
        let mut w_obs: Vec<f64> = Vec::new();

        for c in calls {
            let mv = c["markVol"].as_f64().unwrap_or(0.0);
            let strike = c["strike"].as_f64().unwrap_or(0.0);
            if strike < spot || mv <= 0.0 { continue; }
            ks.push(f64::ln(strike / spot));
            w_obs.push(mv * mv * t);
        }
        for p in puts {
            let mv = p["markVol"].as_f64().unwrap_or(0.0);
            let strike = p["strike"].as_f64().unwrap_or(0.0);
            if strike > spot || mv <= 0.0 { continue; }
            ks.push(f64::ln(strike / spot));
            w_obs.push(mv * mv * t);
        }

        fits_internal.insert(exp.clone(), svi::fit_svi(&ks, &w_obs, t));
    }

    // Term structure (uses native SviFitResult directly — no JSON round-trip)
    let mut term_structure: Vec<Value> = Vec::new();
    for exp in &expirations {
        let expiry_ms = date_to_ms(exp);
        let t = ((expiry_ms - now_ms) as f64 / MS_PER_YEAR).max(1e-4);
        let dte = (t * 365.25).round() as i64;
        let label = date_label(exp);

        let atm_iv: Option<f64> = match fits_internal.get(exp).and_then(|f| f.as_ref()) {
            Some(fit) => {
                let iv = svi::svi_iv(0.0, t, &fit.params);
                Some((iv * 1000.0).round() / 10.0)
            }
            None => {
                // Fallback: closest-to-ATM contract
                let chain = &response["data"][exp];
                let calls = chain["calls"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                let puts  = chain["puts"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
                calls.iter().chain(puts.iter())
                    .filter(|c| c["markVol"].as_f64().map(|v| v > 0.0).unwrap_or(false))
                    .min_by(|a, b| {
                        let da = (a["strike"].as_f64().unwrap_or(0.0) - spot).abs();
                        let db = (b["strike"].as_f64().unwrap_or(0.0) - spot).abs();
                        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .and_then(|c| c["markVol"].as_f64())
                    .map(|mv| (mv * 1000.0).round() / 10.0)
            }
        };

        if let Some(iv) = atm_iv {
            term_structure.push(json!({ "label": label, "dte": dte, "atmIV": iv, "exp": exp }));
        }
    }

    // 25Δ skew data
    let mut skew_data: Vec<Value> = Vec::new();
    for exp in &expirations {
        let chain = &response["data"][exp];
        let empty = vec![];
        let calls = chain["calls"].as_array().unwrap_or(&empty);
        let puts  = chain["puts"].as_array().unwrap_or(&empty);
        if calls.is_empty() || puts.is_empty() { continue; }
        // Require delta data
        if !calls.iter().any(|c| c["delta"].as_f64().map(|d| d != 0.0).unwrap_or(false)) { continue; }

        let call25 = calls.iter()
            .filter(|c| c["delta"].as_f64().map(|d| d >= 0.05 && d <= 0.5).unwrap_or(false))
            .min_by(|a, b| {
                let da = (a["delta"].as_f64().unwrap_or(0.0) - 0.25).abs();
                let db = (b["delta"].as_f64().unwrap_or(0.0) - 0.25).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });

        let put25 = puts.iter()
            .filter(|p| p["delta"].as_f64().map(|d| d <= -0.05 && d >= -0.5).unwrap_or(false))
            .min_by(|a, b| {
                let da = (a["delta"].as_f64().unwrap_or(0.0) + 0.25).abs();
                let db = (b["delta"].as_f64().unwrap_or(0.0) + 0.25).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });

        let atm_call = calls.iter()
            .min_by(|a, b| {
                let da = (a["strike"].as_f64().unwrap_or(0.0) - spot).abs();
                let db = (b["strike"].as_f64().unwrap_or(0.0) - spot).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });

        let c25_mv = call25.and_then(|c| c["markVol"].as_f64()).filter(|&v| v > 0.0);
        let p25_mv = put25.and_then(|p| p["markVol"].as_f64()).filter(|&v| v > 0.0);
        let atm_mv = atm_call.and_then(|c| c["markVol"].as_f64()).filter(|&v| v > 0.0);

        if let (Some(c_mv), Some(p_mv), Some(a_mv)) = (c25_mv, p25_mv, atm_mv) {
            let rr = ((c_mv - p_mv) * 100.0 * 100.0).round() / 100.0;
            let bf = (((c_mv + p_mv) / 2.0 - a_mv) * 100.0 * 100.0).round() / 100.0;
            let label = date_label(exp);
            skew_data.push(json!({ "label": label, "rr": rr, "bf": bf, "exp": exp }));
        }
    }

    let atm_bbo_spread = compute_atm_bbo_spread(&expirations, response, spot);

    // Build svi_fits JSON from native structs (single serialization, no round-trip)
    let svi_fits: serde_json::Map<String, Value> = expirations.iter()
        .map(|exp| {
            let v = fits_internal.get(exp)
                .and_then(|f| f.as_ref())
                .map(|f| f.to_json())
                .unwrap_or(Value::Null);
            (exp.clone(), v)
        })
        .collect();

    Some(json!({
        "sviFits":      svi_fits,
        "termStructure": term_structure,
        "skewData":     skew_data,
        "rawSurface":   raw_surface,
        "atmBboSpread": atm_bbo_spread,
        "updatedAt":    now_ms,
    }))
}
