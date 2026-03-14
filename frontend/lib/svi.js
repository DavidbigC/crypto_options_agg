// JS sibling of `svi.ts` for environments that execute modules directly in Node tests.

export function sviW(k, p) {
  const d = k - p.m
  return p.a + p.b * (p.rho * d + Math.sqrt(d * d + p.sigma * p.sigma))
}

export function sviIV(k, T, p) {
  const w = sviW(k, p)
  return w > 0 ? Math.sqrt(w / T) : 0
}

function minimize(fn, x0) {
  const n = x0.length
  const maxIter = 3000
  const tol = 1e-12

  let simplex = [x0.slice()]
  for (let i = 0; i < n; i++) {
    const v = x0.slice()
    v[i] = v[i] !== 0 ? v[i] * 1.1 : 0.0025
    simplex.push(v)
  }
  let fvals = simplex.map(fn)

  for (let iter = 0; iter < maxIter; iter++) {
    const order = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => fvals[a] - fvals[b])
    simplex = order.map((i) => simplex[i])
    fvals = order.map((i) => fvals[i])

    if (fvals[n] - fvals[0] < tol) break

    const centroid = Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        centroid[j] += simplex[i][j] / n
      }
    }

    const reflected = centroid.map((value, j) => 2 * value - simplex[n][j])
    const reflectedValue = fn(reflected)

    if (reflectedValue < fvals[0]) {
      const expanded = centroid.map((value, j) => 3 * value - 2 * simplex[n][j])
      const expandedValue = fn(expanded)
      if (expandedValue < reflectedValue) {
        simplex[n] = expanded
        fvals[n] = expandedValue
      } else {
        simplex[n] = reflected
        fvals[n] = reflectedValue
      }
    } else if (reflectedValue < fvals[n - 1]) {
      simplex[n] = reflected
      fvals[n] = reflectedValue
    } else {
      const contracted = centroid.map((value, j) => value + 0.5 * (simplex[n][j] - value))
      const contractedValue = fn(contracted)
      if (contractedValue < fvals[n]) {
        simplex[n] = contracted
        fvals[n] = contractedValue
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((value, j) => value + 0.5 * (simplex[i][j] - value))
          fvals[i] = fn(simplex[i])
        }
      }
    }
  }

  return simplex[0]
}

function makeObjective(ks, wObs) {
  const penaltyScale = 1e8
  return ([a, b, rho, m, sigma]) => {
    let penalty = 0
    if (b < 0) penalty += penaltyScale * -b
    if (rho <= -1) penalty += penaltyScale * (1 - rho)
    if (rho >= 1) penalty += penaltyScale * (rho - 0.999)
    if (sigma <= 0) penalty += penaltyScale * -sigma
    const minW = a + b * sigma * Math.sqrt(1 - rho * rho)
    if (minW < 0) penalty += penaltyScale * -minW

    let sse = 0
    for (let i = 0; i < ks.length; i++) {
      const d = ks[i] - m
      const fitted = a + b * (rho * d + Math.sqrt(d * d + sigma * sigma))
      sse += (fitted - wObs[i]) ** 2
    }
    return sse + penalty
  }
}

export function fitSVI(ks, wObs) {
  if (ks.length < 5) return null

  const objective = makeObjective(ks, wObs)
  const meanW = wObs.reduce((sum, value) => sum + value, 0) / wObs.length
  const starts = [
    [meanW * 0.8, 0.10, -0.30, 0.00, 0.10],
    [meanW * 0.8, 0.10, 0.00, 0.00, 0.10],
    [meanW * 0.5, 0.20, -0.50, 0.00, 0.05],
    [meanW * 0.8, 0.10, -0.70, 0.00, 0.10],
    [meanW * 0.8, 0.10, 0.30, 0.00, 0.10],
  ]

  let bestParams = null
  let bestValue = Infinity
  for (const start of starts) {
    const candidate = minimize(objective, start)
    const value = objective(candidate)
    if (value < bestValue) {
      bestValue = value
      bestParams = candidate
    }
  }

  if (!bestParams) return null

  const [a, b, rho, m, sigma] = bestParams
  if (b < -1e-6 || Math.abs(rho) >= 1 || sigma < -1e-6) return null

  const params = {
    a,
    b: Math.max(0, b),
    rho: Math.max(-0.9999, Math.min(0.9999, rho)),
    m,
    sigma: Math.max(1e-6, sigma),
  }

  const rmse = Math.sqrt(
    ks.reduce((sum, k, index) => sum + (sviW(k, params) - wObs[index]) ** 2, 0) / ks.length
  )

  return { params, rmse }
}
