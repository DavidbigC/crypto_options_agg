// frontend/lib/blackScholes.ts

function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

export function bsPrice(
  S: number, K: number, T: number, sigma: number, r: number,
  type: 'call' | 'put'
): number {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S)
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  if (type === 'call') {
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
  }
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1)
}

export interface Greeks {
  delta: number
  gamma: number
  theta: number  // USD/day
  vega: number   // USD per 1% IV change
}

export function bsGreeks(
  S: number, K: number, T: number, sigma: number, r: number,
  type: 'call' | 'put'
): Greeks {
  if (T <= 0) {
    return { delta: type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 }
  }
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const nd1 = normPDF(d1)
  const delta = type === 'call' ? normCDF(d1) : normCDF(d1) - 1
  const gamma = nd1 / (S * sigma * sqrtT)
  const theta = type === 'call'
    ? (-S * nd1 * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-S * nd1 * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365
  const vega = S * nd1 * sqrtT / 100
  return { delta, gamma, theta, vega }
}

/** Back-calculate implied volatility from a market price via bisection */
export function impliedVol(
  S: number, K: number, T: number,
  targetPrice: number,
  type: 'call' | 'put',
  r = 0,
): number {
  if (T <= 0 || targetPrice <= 0 || S <= 0) return 0.5
  // Clamp target to valid range (intrinsic..upper bound)
  const intrinsic = Math.max(0, type === 'call' ? S - K : K - S)
  if (targetPrice <= intrinsic) return 0.001
  let lo = 0.001, hi = 20.0
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    const price = bsPrice(S, K, T, mid, r, type)
    if (Math.abs(price - targetPrice) < 0.01) return mid
    if (price < targetPrice) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Find zero-crossings (breakevens) in a pnl array paired with prices */
export function findBreakevens(prices: number[], pnls: number[]): number[] {
  const result: number[] = []
  for (let i = 1; i < pnls.length; i++) {
    if ((pnls[i - 1] < 0 && pnls[i] >= 0) || (pnls[i - 1] >= 0 && pnls[i] < 0)) {
      const t = -pnls[i - 1] / (pnls[i] - pnls[i - 1])
      result.push(prices[i - 1] + t * (prices[i] - prices[i - 1]))
    }
  }
  return result
}

/**
 * Break-even daily move for a long option position.
 * theta: USD/day (negative value from backend)
 * gamma: per-$1 spot move
 * Returns: minimum $ daily move to break even, or null if inputs invalid
 */
export function calcBreakEven(thetaUSD: number, gamma: number): number | null {
  if (!gamma || gamma <= 0 || !thetaUSD) return null
  return Math.sqrt(2 * Math.abs(thetaUSD) / gamma)
}
