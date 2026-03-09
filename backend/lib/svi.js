// Total implied variance: w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2))
export function sviW(k, p) {
  const d = k - p.m
  return p.a + p.b * (p.rho * d + Math.sqrt(d * d + p.sigma * p.sigma))
}

// Implied vol from SVI at log-moneyness k and time T (years)
export function sviIV(k, T, p) {
  const w = sviW(k, p)
  return w > 0 ? Math.sqrt(w / T) : 0
}

// Nelder-Mead unconstrained minimizer
function minimize(fn, x0) {
  const n = x0.length
  const MAX_ITER = 3000
  const TOL = 1e-12

  let simplex = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const v = x0.slice()
    v[i] = v[i] !== 0 ? v[i] * 1.1 : 0.0025
    simplex.push(v)
  }
  let fvals = simplex.map(fn)

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const order = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => fvals[a] - fvals[b])
    simplex = order.map(i => simplex[i])
    fvals   = order.map(i => fvals[i])

    if (fvals[n] - fvals[0] < TOL) break

    // Centroid of all but worst
    const c = Array(n).fill(0)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        c[j] += simplex[i][j] / n

    const xr = c.map((cj, j) => 2 * cj - simplex[n][j])
    const fr = fn(xr)

    if (fr < fvals[0]) {
      const xe = c.map((cj, j) => 3 * cj - 2 * simplex[n][j])
      const fe = fn(xe)
      if (fe < fr) { simplex[n] = xe; fvals[n] = fe }
      else         { simplex[n] = xr; fvals[n] = fr }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = xr; fvals[n] = fr
    } else {
      const xc = c.map((cj, j) => cj + 0.5 * (simplex[n][j] - cj))
      const fc = fn(xc)
      if (fc < fvals[n]) {
        simplex[n] = xc; fvals[n] = fc
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((s, j) => s + 0.5 * (simplex[i][j] - s))
          fvals[i] = fn(simplex[i])
        }
      }
    }
  }

  return simplex[0]
}

// Objective function with soft no-arbitrage constraints
function makeObjective(ks, wObs) {
  const P = 1e8
  return ([a, b, rho, m, sigma]) => {
    let penalty = 0
    if (b < 0)      penalty += P * (-b)
    if (rho <= -1)  penalty += P * (1 - rho)
    if (rho >= 1)   penalty += P * (rho - 0.999)
    if (sigma <= 0) penalty += P * (-sigma)
    // Ensure non-negative variance everywhere: min(w) = a + b*sigma*sqrt(1-rho^2)
    const minW = a + b * sigma * Math.sqrt(1 - rho * rho)
    if (minW < 0)   penalty += P * (-minW)

    let sse = 0
    for (let i = 0; i < ks.length; i++) {
      const d = ks[i] - m
      const wFit = a + b * (rho * d + Math.sqrt(d * d + sigma * sigma))
      sse += (wFit - wObs[i]) ** 2
    }
    return sse + penalty
  }
}

// Fit SVI to (log-moneyness, total variance) pairs.
// wObs[i] = markIV[i]^2 * T
export function fitSVI(ks, wObs) {
  if (ks.length < 5) return null

  const obj = makeObjective(ks, wObs)
  const wMean = wObs.reduce((s, w) => s + w, 0) / wObs.length

  // Try multiple starting points and keep the best
  const starts = [
    [wMean * 0.8, 0.10, -0.30,  0.00, 0.10],
    [wMean * 0.8, 0.10,  0.00,  0.00, 0.10],
    [wMean * 0.5, 0.20, -0.50,  0.00, 0.05],
    [wMean * 0.8, 0.10, -0.70,  0.00, 0.10],
    [wMean * 0.8, 0.10,  0.30,  0.00, 0.10],
  ]

  let bestParams = null
  let bestVal = Infinity
  for (const x0 of starts) {
    const result = minimize(obj, x0)
    const val = obj(result)
    if (val < bestVal) { bestVal = val; bestParams = result }
  }

  if (!bestParams) return null

  const [a, b, rho, m, sigma] = bestParams
  if (b < -1e-6 || Math.abs(rho) >= 1 || sigma < -1e-6) return null

  const params = {
    a,
    b:     Math.max(0,       b),
    rho:   Math.max(-0.9999, Math.min(0.9999, rho)),
    m,
    sigma: Math.max(1e-6,    sigma),
  }

  const rmse = Math.sqrt(
    ks.reduce((s, k, i) => s + (sviW(k, params) - wObs[i]) ** 2, 0) / ks.length
  )

  return { params, rmse }
}

// Generate nPoints along the fitted curve between kMin and kMax
export function sviCurve(params, T, forward, kMin, kMax, nPoints = 120) {
  return Array.from({ length: nPoints }, (_, i) => {
    const k  = kMin + (kMax - kMin) * i / (nPoints - 1)
    const iv = sviIV(k, T, params)
    return { k, strike: forward * Math.exp(k), iv: iv * 100 }
  }).filter(p => p.iv > 0 && p.iv < 500)
}
