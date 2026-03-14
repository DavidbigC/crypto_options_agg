use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::state::AppState;

// ─── Constants ───────────────────────────────────────────────────────────────

const TAKER_FEE: f64 = 0.0003;

fn fee_cap(exchange: &str) -> f64 {
    match exchange {
        "bybit" => 0.07,
        "okx" => 0.07,
        "deribit" => 0.125,
        _ => 0.07,
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn future_expirations(expirations: &[String]) -> Vec<String> {
    let now = now_ms();
    expirations
        .iter()
        .filter(|exp| {
            let ts = parse_expiry_ms(exp);
            ts > now
        })
        .cloned()
        .collect()
}

fn parse_expiry_ms(expiry: &str) -> u64 {
    // Parse "YYYY-MM-DD" → unix ms at 08:00:00Z
    let parts: Vec<&str> = expiry.split('-').collect();
    if parts.len() != 3 {
        return 0;
    }
    let year: i64 = parts[0].parse().unwrap_or(0);
    let month: i64 = parts[1].parse().unwrap_or(0);
    let day: i64 = parts[2].parse().unwrap_or(0);

    // Days from epoch
    let days = ymd_to_days(year, month, day);
    let secs = days as i64 * 86400 + 8 * 3600; // 08:00:00Z
    if secs < 0 {
        0
    } else {
        secs as u64 * 1000
    }
}

fn ymd_to_days(year: i64, month: i64, day: i64) -> i64 {
    days_from_epoch(year, month, day)
}

fn days_from_epoch(year: i64, month: i64, day: i64) -> i64 {
    // Convert to days since 1970-01-01
    let months_days = [31i64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut total_days = 0i64;

    // Years
    for y in 1970..year {
        total_days += if is_leap(y as u32) { 366 } else { 365 };
    }

    // Months
    let is_ly = is_leap(year as u32);
    for m in 1..month {
        let d = if m == 2 && is_ly {
            29
        } else {
            months_days[(m - 1) as usize]
        };
        total_days += d;
    }

    // Days
    total_days += day - 1;
    total_days
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn dte(expiry: &str) -> f64 {
    let now = now_ms();
    let exp_ms = parse_expiry_ms(expiry);
    if exp_ms <= now {
        return 0.0;
    }
    (exp_ms - now) as f64 / 86_400_000.0
}

fn get_f64(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn best_ask(contract: &Value, exchanges: &[&str]) -> f64 {
    let mut best = 0.0f64;
    for ex in exchanges {
        let raw = contract
            .get("prices")
            .and_then(|p| p.get(ex))
            .and_then(|e| e.get("ask"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if raw > 0.0 && (best == 0.0 || raw < best) {
            best = raw;
        }
    }
    best
}

fn best_bid(contract: &Value, exchanges: &[&str]) -> f64 {
    let mut best = 0.0f64;
    for ex in exchanges {
        let raw = contract
            .get("prices")
            .and_then(|p| p.get(ex))
            .and_then(|e| e.get("bid"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if raw > best {
            best = raw;
        }
    }
    best
}

fn best_exchange(contract: &Value, side: &str, exchanges: &[&str]) -> (f64, Option<String>) {
    let mut best_val = 0.0f64;
    let mut best_ex: Option<String> = None;
    for ex in exchanges {
        let raw = if side == "buy" {
            contract
                .get("prices")
                .and_then(|p| p.get(ex))
                .and_then(|e| e.get("ask"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
        } else {
            contract
                .get("prices")
                .and_then(|p| p.get(ex))
                .and_then(|e| e.get("bid"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0)
        };
        if raw > 0.0 {
            if side == "buy" && (best_val == 0.0 || raw < best_val) {
                best_val = raw;
                best_ex = Some(ex.to_string());
            }
            if side == "sell" && raw > best_val {
                best_val = raw;
                best_ex = Some(ex.to_string());
            }
        }
    }
    (best_val, best_ex)
}

fn with_fee(price: f64, side: &str, exchange: &str, spot_price: f64) -> f64 {
    if price == 0.0 {
        return 0.0;
    }
    let cap = fee_cap(exchange);
    let fee = (TAKER_FEE * spot_price).min(cap * price);
    if side == "buy" {
        price + fee
    } else {
        price - fee
    }
}

fn find_contract<'a>(chain: &'a Value, strike: f64, option_type: &str) -> Option<&'a Value> {
    let arr = if option_type == "call" {
        chain.get("calls")
    } else {
        chain.get("puts")
    };
    arr.and_then(|a| a.as_array()).and_then(|arr| {
        arr.iter().find(|c| {
            c.get("strike")
                .and_then(|v| v.as_f64())
                .map(|s| (s - strike).abs() < 0.001)
                .unwrap_or(false)
        })
    })
}

// ─── Strike Buckets ──────────────────────────────────────────────────────────

struct StrikeBuckets {
    atm: f64,
    otm_call1: f64,
    otm_call2: f64,
    otm_call3: f64,
    otm_call4: f64,
    otm_put1: f64,
    otm_put2: f64,
    otm_put3: f64,
    otm_put4: f64,
    itm_call1: f64,
    itm_put1: f64,
}

fn strike_buckets(chain: &Value, spot_price: f64, expiry_str: &str) -> Option<StrikeBuckets> {
    let t = dte(expiry_str) / 365.0;
    if t <= 0.0 {
        return None;
    }

    let calls = chain.get("calls").and_then(|v| v.as_array())?;
    let puts = chain.get("puts").and_then(|v| v.as_array())?;

    let mut all_strikes_raw: Vec<f64> = calls
        .iter()
        .chain(puts.iter())
        .filter_map(|c| c.get("strike").and_then(|v| v.as_f64()))
        .collect();
    all_strikes_raw.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    all_strikes_raw.dedup_by(|a, b| (*a - *b).abs() < 0.001);
    let mut all_strikes = all_strikes_raw;
    all_strikes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    if all_strikes.is_empty() {
        return None;
    }

    let atm = *all_strikes
        .iter()
        .min_by(|a, b| {
            ((*a - spot_price).abs())
                .partial_cmp(&((*b - spot_price).abs()))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap();

    let atm_call = calls.iter().find(|c| {
        c.get("strike")
            .and_then(|v| v.as_f64())
            .map(|s| (s - atm).abs() < 0.001)
            .unwrap_or(false)
    });
    let atm_iv = atm_call
        .and_then(|c| c.get("markVol"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.7);
    let sigma = atm_iv * t.sqrt() * spot_price;

    let target = |n: f64| spot_price + n * sigma;
    let closest = |tp: f64| {
        *all_strikes
            .iter()
            .min_by(|a, b| {
                ((*a - tp).abs())
                    .partial_cmp(&((*b - tp).abs()))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(&atm)
    };

    Some(StrikeBuckets {
        atm,
        otm_call1: closest(target(0.5)),
        otm_call2: closest(target(1.0)),
        otm_call3: closest(target(1.5)),
        otm_call4: closest(target(2.0)),
        otm_put1: closest(target(-0.5)),
        otm_put2: closest(target(-1.0)),
        otm_put3: closest(target(-1.5)),
        otm_put4: closest(target(-2.0)),
        itm_call1: closest(target(-0.5)),
        itm_put1: closest(target(0.5)),
    })
}

// ─── Greeks ──────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
struct NetGreeks {
    delta: f64,
    gamma: f64,
    theta: f64,
    vega: f64,
}

// ─── Leg Spec ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct LegSpec {
    side: String,     // "buy" | "sell"
    leg_type: String, // "call" | "put" | "future"
    strike: f64,
    expiry: String,
    qty: f64,
}

#[derive(Clone, Debug)]
struct Leg {
    side: String,
    leg_type: String,
    strike: f64,
    expiry: String,
    qty: f64,
    price: f64,
    exchange: String,
}

impl Leg {
    fn to_json(&self) -> Value {
        json!({
            "side": self.side,
            "type": self.leg_type,
            "strike": self.strike,
            "expiry": self.expiry,
            "qty": self.qty,
            "price": self.price,
            "exchange": self.exchange,
        })
    }
}

#[derive(Clone, Debug)]
struct Candidate {
    name: String,
    legs: Vec<Leg>,
    net_greeks: NetGreeks,
    total_cost: f64,
}

// ─── Build Candidate ─────────────────────────────────────────────────────────

fn build_candidate(
    name: &str,
    leg_specs: &[LegSpec],
    chain_by_expiry: &HashMap<String, &Value>,
    spot_price: f64,
    exchanges: &[&str],
) -> Option<Candidate> {
    let mut legs: Vec<Leg> = Vec::new();
    let mut total_cost = 0.0f64;
    let mut net_greeks = NetGreeks::default();

    for spec in leg_specs {
        if spec.leg_type == "future" {
            let sign = if spec.side == "buy" { 1.0 } else { -1.0 };
            legs.push(Leg {
                side: spec.side.clone(),
                leg_type: spec.leg_type.clone(),
                strike: spec.strike,
                expiry: spec.expiry.clone(),
                qty: spec.qty,
                price: spot_price,
                exchange: "bybit".to_string(),
            });
            net_greeks.delta += sign * spec.qty;
            continue;
        }

        let chain = chain_by_expiry.get(&spec.expiry)?;
        let contract = find_contract(chain, spec.strike, &spec.leg_type)?;

        let (price, exchange) = best_exchange(contract, &spec.side, exchanges);
        let exchange = exchange?;
        if price == 0.0 {
            return None;
        }

        let fee_price = with_fee(price, &spec.side, &exchange, spot_price);
        let sign = if spec.side == "buy" { 1.0 } else { -1.0 };

        legs.push(Leg {
            side: spec.side.clone(),
            leg_type: spec.leg_type.clone(),
            strike: spec.strike,
            expiry: spec.expiry.clone(),
            qty: spec.qty,
            price: fee_price,
            exchange,
        });

        if spec.side == "buy" {
            total_cost += fee_price * spec.qty;
        } else {
            total_cost -= fee_price * spec.qty;
        }

        net_greeks.delta += sign * get_f64(contract, "delta") * spec.qty;
        net_greeks.gamma += sign * get_f64(contract, "gamma") * spec.qty;
        net_greeks.theta += sign * get_f64(contract, "theta") * spec.qty;
        net_greeks.vega += sign * get_f64(contract, "vega") * spec.qty;
    }

    Some(Candidate {
        name: name.to_string(),
        legs,
        net_greeks,
        total_cost,
    })
}

// ─── Score ────────────────────────────────────────────────────────────────────

fn score_strategy(net_greeks: &NetGreeks, targets: &Value, total_cost: f64) -> f64 {
    let keys = ["delta", "gamma", "vega", "theta"];
    let mut score = 0.0f64;
    let mut targeted = 0i32;

    for g in &keys {
        let target = targets.get(g).and_then(|v| v.as_str()).unwrap_or("ignore");
        if target == "ignore" || target.is_empty() {
            continue;
        }
        targeted += 1;
        let val = match *g {
            "delta" => net_greeks.delta,
            "gamma" => net_greeks.gamma,
            "vega" => net_greeks.vega,
            "theta" => net_greeks.theta,
            _ => 0.0,
        };

        let alignment = match target {
            "long" => {
                if val > 0.0 {
                    1.0
                } else if val < 0.0 {
                    -1.0
                } else {
                    0.0
                }
            }
            "short" => {
                if val < 0.0 {
                    1.0
                } else if val > 0.0 {
                    -1.0
                } else {
                    0.0
                }
            }
            "neutral" => {
                if val.abs() < 0.05 {
                    1.0
                } else {
                    -0.5
                }
            }
            _ => 0.0,
        };

        score += alignment;
    }

    if targeted == 0 {
        return 0.0;
    }
    (score / targeted as f64) / total_cost.abs().max(1.0) * 1000.0
}

// ─── Rebalancing Note ─────────────────────────────────────────────────────────

fn compute_rebalancing_note(net_greeks: &NetGreeks, legs: &[Leg], spot_price: f64) -> String {
    let mut notes: Vec<String> = Vec::new();

    if net_greeks.gamma.abs() > 0.0001 && net_greeks.delta.abs() < 0.15 {
        let delta_tol = 0.10;
        let rebalance_move = delta_tol / net_greeks.gamma.abs();
        let rebalance_pct = (rebalance_move / spot_price * 100.0 * 10.0).round() / 10.0;
        notes.push(format!(
            "Delta drifts ~±{:.2} per ${:.0} spot move. Consider re-hedging when spot moves ±{}% (~${:.0}).",
            delta_tol,
            rebalance_move,
            rebalance_pct,
            rebalance_move
        ));
    }

    let option_legs: Vec<&Leg> = legs.iter().filter(|l| l.leg_type != "future").collect();
    if !option_legs.is_empty() {
        let days_left: Vec<f64> = option_legs
            .iter()
            .map(|l| dte(&l.expiry))
            .filter(|&d| d > 0.0)
            .collect();
        if !days_left.is_empty() {
            let near_days = days_left.iter().cloned().fold(f64::INFINITY, f64::min);
            if near_days <= 14.0 {
                notes.push(format!(
                    "Near leg expires in {} days — roll or close before expiry.",
                    near_days.round() as i64
                ));
            }
        }
    }

    let long_legs: Vec<&Leg> = option_legs
        .iter()
        .filter(|l| l.side == "buy")
        .copied()
        .collect();
    let short_legs: Vec<&Leg> = option_legs
        .iter()
        .filter(|l| l.side == "sell")
        .copied()
        .collect();

    if !long_legs.is_empty() && !short_legs.is_empty() {
        let latest_short = short_legs
            .iter()
            .map(|l| parse_expiry_ms(&l.expiry))
            .max()
            .unwrap_or(0);
        let latest_long = long_legs
            .iter()
            .map(|l| parse_expiry_ms(&l.expiry))
            .max()
            .unwrap_or(0);
        if latest_short < latest_long {
            notes.push(
                "Short leg expires before long leg — vega exposure reverses after short leg expires."
                    .to_string(),
            );
        }
    }

    if notes.is_empty() {
        "No special rebalancing required.".to_string()
    } else {
        notes.join(" ")
    }
}

// ─── Strategy Enumeration ────────────────────────────────────────────────────

macro_rules! leg {
    ($side:expr, $type:expr, $strike:expr, $expiry:expr, $qty:expr) => {
        LegSpec {
            side: $side.to_string(),
            leg_type: $type.to_string(),
            strike: $strike,
            expiry: $expiry.to_string(),
            qty: $qty,
        }
    };
}

fn enum_single_expiry(
    expiry: &str,
    chain: &Value,
    spot_price: f64,
    max_legs: usize,
    exchanges: &[&str],
) -> Vec<Candidate> {
    let b = match strike_buckets(chain, spot_price, expiry) {
        Some(b) => b,
        None => return vec![],
    };
    let mut candidates: Vec<Candidate> = Vec::new();
    let chains: HashMap<String, &Value> = [(expiry.to_string(), chain)].into_iter().collect();

    let mut add = |name: &str, specs: &[LegSpec]| {
        if let Some(c) = build_candidate(name, specs, &chains, spot_price, exchanges) {
            candidates.push(c);
        }
    };

    if max_legs >= 2 {
        add(
            "Straddle",
            &[
                leg!("buy", "call", b.atm, expiry, 1.0),
                leg!("buy", "put", b.atm, expiry, 1.0),
            ],
        );

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Strangle",
                &[
                    leg!("buy", "call", b.otm_call1, expiry, 1.0),
                    leg!("buy", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call2 - b.otm_call1).abs() > 0.001 {
            add(
                "Wide Strangle",
                &[
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                    leg!("buy", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }

        add(
            "Short Straddle",
            &[
                leg!("sell", "call", b.atm, expiry, 1.0),
                leg!("sell", "put", b.atm, expiry, 1.0),
            ],
        );

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Short Strangle",
                &[
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 {
            add(
                "Bull Call Spread",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                ],
            );
            add(
                "Bear Call Spread",
                &[
                    leg!("sell", "call", b.atm, expiry, 1.0),
                    leg!("buy", "call", b.otm_call1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Bear Put Spread",
                &[
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
            add(
                "Bull Put Spread",
                &[
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Risk Reversal (Bullish)",
                &[
                    leg!("buy", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
            add(
                "Risk Reversal (Bearish)",
                &[
                    leg!("buy", "put", b.otm_put1, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                ],
            );
        }

        if (b.itm_call1 - b.atm).abs() > 0.001 {
            add(
                "Long Guts",
                &[
                    leg!("buy", "call", b.itm_call1, expiry, 1.0),
                    leg!("buy", "put", b.itm_put1, expiry, 1.0),
                ],
            );
        }
    }

    if max_legs >= 3 {
        if (b.otm_call1 - b.atm).abs() > 0.001 {
            add(
                "Ratio Call Spread",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 2.0),
                ],
            );
        }

        if (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Ratio Put Spread",
                &[
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 2.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_call2 - b.otm_call1).abs() > 0.001 {
            add(
                "Call Butterfly",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 2.0),
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_put1 - b.atm).abs() > 0.001 && (b.otm_put2 - b.otm_put1).abs() > 0.001 {
            add(
                "Put Butterfly",
                &[
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 2.0),
                    leg!("buy", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_call2 - b.otm_call1).abs() > 0.001 {
            add(
                "Jade Lizard",
                &[
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                ],
            );
        }

        if (b.itm_call1 - b.atm).abs() > 0.001 && (b.otm_call1 - b.atm).abs() > 0.001 {
            add(
                "Call Ladder",
                &[
                    leg!("buy", "call", b.itm_call1, expiry, 1.0),
                    leg!("sell", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                ],
            );
        }

        if (b.itm_put1 - b.atm).abs() > 0.001 && (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Put Ladder",
                &[
                    leg!("buy", "put", b.itm_put1, expiry, 1.0),
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_call2 - b.otm_call1).abs() > 0.001 {
            add(
                "Call Backspread",
                &[
                    leg!("sell", "call", b.atm, expiry, 1.0),
                    leg!("buy", "call", b.otm_call1, expiry, 2.0),
                ],
            );
        }

        if (b.otm_put1 - b.atm).abs() > 0.001 && (b.otm_put2 - b.otm_put1).abs() > 0.001 {
            add(
                "Put Backspread",
                &[
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.otm_put1, expiry, 2.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_call2 - b.otm_call1).abs() > 0.001 {
            add(
                "Short Call Butterfly",
                &[
                    leg!("sell", "call", b.atm, expiry, 1.0),
                    leg!("buy", "call", b.otm_call1, expiry, 2.0),
                    leg!("sell", "call", b.otm_call2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_put1 - b.atm).abs() > 0.001 && (b.otm_put2 - b.otm_put1).abs() > 0.001 {
            add(
                "Short Put Butterfly",
                &[
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.otm_put1, expiry, 2.0),
                    leg!("sell", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001
            && (b.otm_call2 - b.otm_call1).abs() > 0.001
            && (b.otm_put1 - b.atm).abs() > 0.001
        {
            add(
                "Seagull (Bullish)",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                ],
            );
            add(
                "Seagull (Bearish)",
                &[
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }
    }

    if max_legs >= 4 {
        if (b.otm_call1 - b.atm).abs() > 0.001
            && (b.otm_put1 - b.atm).abs() > 0.001
            && (b.otm_call2 - b.otm_call1).abs() > 0.001
            && (b.otm_put2 - b.otm_put1).abs() > 0.001
        {
            add(
                "Iron Condor",
                &[
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                    leg!("buy", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_call3 - b.otm_call1).abs() > 0.001 {
            add(
                "Broken Wing Butterfly (Call)",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 2.0),
                    leg!("buy", "call", b.otm_call3, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call2 - b.atm).abs() > 0.001 && (b.otm_put2 - b.atm).abs() > 0.001 {
            add(
                "Iron Butterfly",
                &[
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                    leg!("sell", "call", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001 && (b.otm_put1 - b.atm).abs() > 0.001 {
            add(
                "Reverse Iron Butterfly",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                ],
            );
        }

        if (b.otm_call1 - b.atm).abs() > 0.001
            && (b.otm_put1 - b.atm).abs() > 0.001
            && (b.otm_call2 - b.otm_call1).abs() > 0.001
            && (b.otm_put2 - b.otm_put1).abs() > 0.001
        {
            add(
                "Reverse Iron Condor",
                &[
                    leg!("buy", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "call", b.otm_call2, expiry, 1.0),
                    leg!("buy", "put", b.otm_put1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }
    }

    if max_legs >= 5 {
        if (b.otm_call3 - b.otm_call2).abs() > 0.001 {
            add(
                "Call Condor",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 1.0),
                    leg!("sell", "call", b.otm_call2, expiry, 1.0),
                    leg!("buy", "call", b.otm_call3, expiry, 1.0),
                ],
            );
            add(
                "Put Condor",
                &[
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "put", b.otm_put1, expiry, 1.0),
                    leg!("sell", "put", b.otm_put2, expiry, 1.0),
                    leg!("buy", "put", b.otm_put3, expiry, 1.0),
                ],
            );
        }
    }

    if max_legs >= 6 {
        if (b.otm_call1 - b.atm).abs() > 0.001
            && (b.otm_put1 - b.atm).abs() > 0.001
            && (b.otm_call2 - b.otm_call1).abs() > 0.001
            && (b.otm_put2 - b.otm_put1).abs() > 0.001
        {
            add(
                "Double Ratio Spread",
                &[
                    leg!("buy", "call", b.atm, expiry, 1.0),
                    leg!("buy", "put", b.atm, expiry, 1.0),
                    leg!("sell", "call", b.otm_call1, expiry, 2.0),
                    leg!("sell", "put", b.otm_put1, expiry, 2.0),
                    leg!("buy", "call", b.otm_call2, expiry, 1.0),
                    leg!("buy", "put", b.otm_put2, expiry, 1.0),
                ],
            );
        }
    }

    candidates
}

fn enum_calendars(
    expirations: &[String],
    chain_by_expiry: &HashMap<String, Value>,
    spot_price: f64,
    max_legs: usize,
    exchanges: &[&str],
) -> Vec<Candidate> {
    if max_legs < 2 {
        return vec![];
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    for i in 0..expirations.len() {
        for j in (i + 1)..expirations.len() {
            let near_exp = &expirations[i];
            let far_exp = &expirations[j];

            let near_chain = match chain_by_expiry.get(near_exp) {
                Some(c) => c,
                None => continue,
            };
            let far_chain = match chain_by_expiry.get(far_exp) {
                Some(c) => c,
                None => continue,
            };

            let b_near = match strike_buckets(near_chain, spot_price, near_exp) {
                Some(b) => b,
                None => continue,
            };
            let b_far = match strike_buckets(far_chain, spot_price, far_exp) {
                Some(b) => b,
                None => continue,
            };

            let chains: HashMap<String, &Value> =
                [(near_exp.clone(), near_chain), (far_exp.clone(), far_chain)]
                    .into_iter()
                    .collect();

            let mut add = |name: &str, specs: &[LegSpec]| {
                if let Some(c) = build_candidate(name, specs, &chains, spot_price, exchanges) {
                    candidates.push(c);
                }
            };

            add(
                "Call Calendar",
                &[
                    leg!("sell", "call", b_near.atm, near_exp, 1.0),
                    leg!("buy", "call", b_far.atm, far_exp, 1.0),
                ],
            );

            add(
                "Put Calendar",
                &[
                    leg!("sell", "put", b_near.atm, near_exp, 1.0),
                    leg!("buy", "put", b_far.atm, far_exp, 1.0),
                ],
            );

            if (b_near.otm_call1 - b_near.atm).abs() > 0.001 {
                add(
                    "Call Diagonal",
                    &[
                        leg!("sell", "call", b_near.otm_call1, near_exp, 1.0),
                        leg!("buy", "call", b_far.atm, far_exp, 1.0),
                    ],
                );
            }

            if (b_near.otm_put1 - b_near.atm).abs() > 0.001 {
                add(
                    "Put Diagonal",
                    &[
                        leg!("sell", "put", b_near.otm_put1, near_exp, 1.0),
                        leg!("buy", "put", b_far.atm, far_exp, 1.0),
                    ],
                );
            }

            if max_legs >= 4 {
                add(
                    "Double Calendar",
                    &[
                        leg!("sell", "call", b_near.atm, near_exp, 1.0),
                        leg!("buy", "call", b_far.atm, far_exp, 1.0),
                        leg!("sell", "put", b_near.atm, near_exp, 1.0),
                        leg!("buy", "put", b_far.atm, far_exp, 1.0),
                    ],
                );
            }
        }
    }

    candidates
}

fn add_delta_hedge(candidate: &mut Candidate, spot_price: f64, futures: &[Value]) {
    let net_delta = candidate.net_greeks.delta;
    if net_delta.abs() < 0.02 {
        return;
    }

    let perp = futures.iter().find(|f| {
        f.get("isPerp").and_then(|v| v.as_bool()).unwrap_or(false)
            && f.get("markPrice").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0
    });

    let perp = match perp {
        Some(p) => p,
        None => return,
    };

    let side = if net_delta > 0.0 { "sell" } else { "buy" };
    let qty = net_delta.abs();
    let price = perp
        .get("markPrice")
        .and_then(|v| v.as_f64())
        .unwrap_or(spot_price);
    let exchange = perp
        .get("exchange")
        .and_then(|v| v.as_str())
        .unwrap_or("bybit")
        .to_string();

    candidate.legs.push(Leg {
        side: side.to_string(),
        leg_type: "future".to_string(),
        strike: 0.0,
        expiry: "perpetual".to_string(),
        qty,
        price,
        exchange,
    });

    let sign = if side == "buy" { 1.0 } else { -1.0 };
    candidate.net_greeks.delta += sign * qty;
}

// ─── Main Optimizer ────────────────────────────────────────────────────────────

pub fn run_optimizer(
    options_data: &Value,
    spot_price: f64,
    futures: &[Value],
    targets: &Value,
    max_cost: f64,
    max_legs: usize,
    target_expiry: Option<&str>,
    exchanges: &[&str],
) -> Vec<Value> {
    if spot_price == 0.0 {
        return vec![];
    }

    let expirations_raw: Vec<String> = options_data
        .get("expirations")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let mut expirations = future_expirations(&expirations_raw);

    if let Some(target) = target_expiry {
        let target_ts = parse_expiry_ms(target);
        let window_ms = 3 * 86_400_000u64;
        expirations.retain(|exp| {
            let exp_ts = parse_expiry_ms(exp);
            let diff = if exp_ts > target_ts {
                exp_ts - target_ts
            } else {
                target_ts - exp_ts
            };
            diff <= window_ms
        });
    }

    let chain_by_expiry: HashMap<String, Value> = options_data
        .get("data")
        .and_then(|d| d.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();

    let mut candidates: Vec<Candidate> = Vec::new();

    for expiry in &expirations {
        let chain = match chain_by_expiry.get(expiry) {
            Some(c) => c,
            None => continue,
        };
        let calls = chain.get("calls").and_then(|v| v.as_array());
        let puts = chain.get("puts").and_then(|v| v.as_array());
        if calls.map(|a| a.is_empty()).unwrap_or(true) || puts.map(|a| a.is_empty()).unwrap_or(true)
        {
            continue;
        }
        candidates.extend(enum_single_expiry(
            expiry, chain, spot_price, max_legs, exchanges,
        ));
    }

    candidates.extend(enum_calendars(
        &expirations,
        &chain_by_expiry,
        spot_price,
        max_legs,
        exchanges,
    ));

    let delta_target = targets
        .get("delta")
        .and_then(|v| v.as_str())
        .unwrap_or("ignore");
    if delta_target == "neutral" {
        for c in &mut candidates {
            add_delta_hedge(c, spot_price, futures);
        }
    }

    let mut scored: Vec<(Candidate, f64, String)> = candidates
        .into_iter()
        .filter(|c| {
            if c.legs.is_empty() {
                return false;
            }
            if max_cost > 0.0 && c.total_cost > max_cost {
                return false;
            }
            true
        })
        .map(|c| {
            let score = score_strategy(&c.net_greeks, targets, c.total_cost);
            let note = compute_rebalancing_note(&c.net_greeks, &c.legs, spot_price);
            (c, score, note)
        })
        .filter(|(_, score, _)| *score > 0.0)
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Deduplicate
    let mut seen: HashSet<String> = HashSet::new();
    let mut deduped: Vec<(Candidate, f64, String)> = Vec::new();
    for item in scored {
        let key = format!(
            "{}|{}",
            item.0.name,
            item.0
                .legs
                .iter()
                .map(|l| format!("{}:{}:{}:{}", l.expiry, l.strike, l.leg_type, l.side))
                .collect::<Vec<_>>()
                .join(",")
        );
        if !seen.contains(&key) {
            seen.insert(key);
            deduped.push(item);
        }
    }

    // Top 10 + up to 5 best multi-expiry
    let is_multi_expiry = |c: &Candidate| -> bool {
        let expiries: HashSet<&str> = c
            .legs
            .iter()
            .filter(|l| l.leg_type != "future")
            .map(|l| l.expiry.as_str())
            .collect();
        expiries.len() > 1
    };

    let top10: Vec<(Candidate, f64, String)> = deduped.iter().take(10).cloned().collect();
    let top10_keys: HashSet<String> = top10
        .iter()
        .map(|(c, _, _)| {
            format!(
                "{}|{}",
                c.name,
                c.legs
                    .iter()
                    .map(|l| format!("{}:{}:{}:{}", l.expiry, l.strike, l.leg_type, l.side))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect();

    let bonus_multi: Vec<(Candidate, f64, String)> = deduped
        .iter()
        .filter(|(c, _, _)| is_multi_expiry(c))
        .filter(|(c, _, _)| {
            let key = format!(
                "{}|{}",
                c.name,
                c.legs
                    .iter()
                    .map(|l| format!("{}:{}:{}:{}", l.expiry, l.strike, l.leg_type, l.side))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            !top10_keys.contains(&key)
        })
        .take(5)
        .cloned()
        .collect();

    let mut result_items: Vec<(Candidate, f64, String)> = [top10, bonus_multi].concat();
    result_items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    result_items
        .into_iter()
        .map(|(c, score, note)| {
            json!({
                "name": c.name,
                "legs": c.legs.iter().map(|l| l.to_json()).collect::<Vec<_>>(),
                "netGreeks": {
                    "delta": c.net_greeks.delta,
                    "gamma": c.net_greeks.gamma,
                    "theta": c.net_greeks.theta,
                    "vega": c.net_greeks.vega,
                },
                "totalCost": c.total_cost,
                "score": score,
                "rebalancingNote": note,
            })
        })
        .collect()
}

// ─── Route Handler ────────────────────────────────────────────────────────────

pub async fn handler(
    Path(_coin): Path<String>,
    State(_state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let targets = body.get("targets").cloned().unwrap_or(json!({}));
    let max_cost = body.get("maxCost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let max_legs = body.get("maxLegs").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
    let target_expiry = body
        .get("targetExpiry")
        .and_then(|v| v.as_str())
        .map(String::from);
    let exchanges_raw: Vec<String> = body
        .get("exchanges")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(String::from)
                .collect()
        })
        .unwrap_or_else(|| vec!["bybit".into(), "okx".into(), "deribit".into()]);

    let options_data = body.get("optionsData").cloned().unwrap_or(json!({}));
    let spot_price = body.get("spot").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let futures_raw: Vec<Value> = body
        .get("futures")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if spot_price == 0.0 {
        return Json(json!({ "error": "spot price required" }));
    }

    let exchanges_ref: Vec<&str> = exchanges_raw.iter().map(|s| s.as_str()).collect();
    let target_expiry_ref = target_expiry.as_deref();

    let results = run_optimizer(
        &options_data,
        spot_price,
        &futures_raw,
        &targets,
        max_cost,
        max_legs,
        target_expiry_ref,
        &exchanges_ref,
    );

    Json(json!({ "results": results }))
}
