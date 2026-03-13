use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SviParams {
    pub a:     f64,
    pub b:     f64,
    pub rho:   f64,
    pub m:     f64,
    pub sigma: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SviFitResult {
    pub params: SviParams,
    pub rmse:   f64,
    #[serde(rename = "T")]
    pub t:      f64,
}

impl SviFitResult {
    pub fn to_json(&self) -> Value {
        json!({
            "params": {
                "a":     self.params.a,
                "b":     self.params.b,
                "rho":   self.params.rho,
                "m":     self.params.m,
                "sigma": self.params.sigma,
            },
            "rmse": self.rmse,
            "T":    self.t,
        })
    }
}

pub fn svi_w(k: f64, p: &SviParams) -> f64 {
    let d = k - p.m;
    p.a + p.b * (p.rho * d + (d * d + p.sigma * p.sigma).sqrt())
}

pub fn svi_iv(k: f64, t: f64, p: &SviParams) -> f64 {
    let w = svi_w(k, p);
    if w > 0.0 { (w / t).sqrt() } else { 0.0 }
}

fn minimize(f: &impl Fn(&[f64]) -> f64, x0: &[f64]) -> Vec<f64> {
    let n = x0.len();
    const MAX_ITER: usize = 3000;
    const TOL: f64 = 1e-12;

    let mut simplex: Vec<Vec<f64>> = vec![x0.to_vec()];
    for i in 0..n {
        let mut v = x0.to_vec();
        v[i] = if v[i] != 0.0 { v[i] * 1.1 } else { 0.0025 };
        simplex.push(v);
    }
    let mut fvals: Vec<f64> = simplex.iter().map(|x| f(x)).collect();

    for _ in 0..MAX_ITER {
        let mut order: Vec<usize> = (0..=n).collect();
        order.sort_by(|&a, &b| fvals[a].partial_cmp(&fvals[b]).unwrap_or(std::cmp::Ordering::Equal));
        let new_simplex: Vec<Vec<f64>> = order.iter().map(|&i| simplex[i].clone()).collect();
        let new_fvals: Vec<f64> = order.iter().map(|&i| fvals[i]).collect();
        simplex = new_simplex;
        fvals = new_fvals;

        if fvals[n] - fvals[0] < TOL { break; }

        // Centroid of all but worst
        let mut c = vec![0.0f64; n];
        for i in 0..n {
            for j in 0..n {
                c[j] += simplex[i][j] / n as f64;
            }
        }

        let xr: Vec<f64> = c.iter().zip(&simplex[n]).map(|(&cj, &sj)| 2.0 * cj - sj).collect();
        let fr = f(&xr);

        if fr < fvals[0] {
            let xe: Vec<f64> = c.iter().zip(&simplex[n]).map(|(&cj, &sj)| 3.0 * cj - 2.0 * sj).collect();
            let fe = f(&xe);
            if fe < fr { simplex[n] = xe; fvals[n] = fe; }
            else { simplex[n] = xr; fvals[n] = fr; }
        } else if fr < fvals[n - 1] {
            simplex[n] = xr;
            fvals[n] = fr;
        } else {
            let xc: Vec<f64> = c.iter().zip(&simplex[n]).map(|(&cj, &sj)| cj + 0.5 * (sj - cj)).collect();
            let fc = f(&xc);
            if fc < fvals[n] {
                simplex[n] = xc;
                fvals[n] = fc;
            } else {
                let best = simplex[0].clone();
                for i in 1..=n {
                    let updated: Vec<f64> = best.iter().zip(&simplex[i])
                        .map(|(&s0, &si)| s0 + 0.5 * (si - s0))
                        .collect();
                    fvals[i] = f(&updated);
                    simplex[i] = updated;
                }
            }
        }
    }

    simplex[0].clone()
}

fn make_objective<'a>(ks: &'a [f64], w_obs: &'a [f64]) -> impl Fn(&[f64]) -> f64 + 'a {
    const P: f64 = 1e8;
    move |x: &[f64]| {
        let (a, b, rho, m, sigma) = (x[0], x[1], x[2], x[3], x[4]);
        let mut penalty = 0.0;
        if b < 0.0      { penalty += P * (-b); }
        if rho <= -1.0  { penalty += P * (1.0 - rho); }
        if rho >= 1.0   { penalty += P * (rho - 0.999); }
        if sigma <= 0.0 { penalty += P * (-sigma); }
        let min_w = a + b * sigma * (1.0 - rho * rho).sqrt();
        if min_w < 0.0  { penalty += P * (-min_w); }

        let sse: f64 = ks.iter().zip(w_obs).map(|(&k, &w)| {
            let d = k - m;
            let w_fit = a + b * (rho * d + (d * d + sigma * sigma).sqrt());
            (w_fit - w).powi(2)
        }).sum();

        sse + penalty
    }
}

/// Fit SVI to (log-moneyness, total-variance) pairs.
/// `w_obs[i] = markIV[i]^2 * T`
pub fn fit_svi(ks: &[f64], w_obs: &[f64], t: f64) -> Option<SviFitResult> {
    if ks.len() < 5 { return None; }

    let w_mean = w_obs.iter().sum::<f64>() / w_obs.len() as f64;
    let starts: &[[f64; 5]] = &[
        [w_mean * 0.8, 0.10, -0.30, 0.00, 0.10],
        [w_mean * 0.8, 0.10,  0.00, 0.00, 0.10],
        [w_mean * 0.5, 0.20, -0.50, 0.00, 0.05],
        [w_mean * 0.8, 0.10, -0.70, 0.00, 0.10],
        [w_mean * 0.8, 0.10,  0.30, 0.00, 0.10],
    ];

    let obj = make_objective(ks, w_obs);
    let mut best: Option<Vec<f64>> = None;
    let mut best_val = f64::INFINITY;

    for x0 in starts {
        let result = minimize(&obj, x0.as_slice());
        let val = obj(&result);
        if val < best_val {
            best_val = val;
            best = Some(result);
        }
    }

    let bp = best?;
    let (a, b, rho, m, sigma) = (bp[0], bp[1], bp[2], bp[3], bp[4]);
    if b < -1e-6 || rho.abs() >= 1.0 || sigma < -1e-6 { return None; }

    let params = SviParams {
        a,
        b:     b.max(0.0),
        rho:   rho.clamp(-0.9999, 0.9999),
        m,
        sigma: sigma.max(1e-6),
    };

    let rmse = (ks.iter().enumerate()
        .map(|(i, &k)| (svi_w(k, &params) - w_obs[i]).powi(2))
        .sum::<f64>() / ks.len() as f64).sqrt();

    Some(SviFitResult { params, rmse, t })
}
