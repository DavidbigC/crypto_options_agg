import { CombinedOptionContract } from '@/types/options'

export interface ArbLeg {
  action: 'buy' | 'sell'
  type: 'call' | 'put' | 'future'
  strike: number
  expiry: string
  qty: number
  price: number
  exchange: string | null
}

export type ArbStrategy =
  | 'call_monotonicity'
  | 'put_monotonicity'
  | 'call_butterfly'
  | 'put_butterfly'
  | 'calendar_arb'
  | 'pcp_conversion'
  | 'pcp_reversal'

export interface ArbOpportunity {
  strategy: ArbStrategy
  expiry: string
  legs: ArbLeg[]
  profit: number
  apr: number
  collateral: number
}

export const TAKER_FEE = 0.0003
export const FEE_CAP: Record<string, number> = { bybit: 0.07, okx: 0.07, deribit: 0.125 }

export function applyFee(price: number, side: 'buy' | 'sell', ex: string | null, spotPrice: number): number {
  if (price === 0) return 0
  const cap = FEE_CAP[ex ?? ''] ?? 0.07
  const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
  return side === 'buy' ? price + fee : price - fee
}

export function bestPrice(
  contract: CombinedOptionContract,
  side: 'buy' | 'sell',
  activeExchanges: Set<string>,
): { val: number; ex: string | null } {
  let bestVal = 0
  let bestEx: string | null = null
  for (const ex of Array.from(activeExchanges)) {
    const prices = contract.prices[ex as keyof typeof contract.prices]
    if (!prices) continue
    const raw = side === 'buy' ? prices.ask : prices.bid
    if (!raw || raw === 0) continue
    if (side === 'sell' && raw > bestVal) { bestVal = raw; bestEx = ex }
    if (side === 'buy'  && (bestVal === 0 || raw < bestVal)) { bestVal = raw; bestEx = ex }
  }
  return { val: bestVal, ex: bestEx }
}

export function calcApr(profit: number, collateral: number, daysToExpiry: number): number {
  if (collateral <= 0 || daysToExpiry <= 0) return 0
  return (profit / collateral) * (365 / daysToExpiry) * 100
}

export interface FutureData {
  symbol: string
  exchange: string
  expiry: string | null   // null = perp
  isPerp: boolean
  markPrice: number
}

/**
 * Find the best futures hedge for a given options expiry.
 * Uses a dated futures if its expiry is within 10% of the options DTE, else falls back to perp.
 */
export function pickHedge(
  optionsExpiry: string,
  futures: FutureData[],
  now = Date.now(),
): { price: number; exchange: string; isPerp: boolean } | null {
  const optsDays = (new Date(optionsExpiry).getTime() - now) / 86_400_000
  if (optsDays <= 0) return null

  // Dated futures within 10% of options DTE
  const threshold = optsDays * 0.10
  let bestDated: FutureData | null = null
  let bestDist = Infinity
  for (const f of futures) {
    if (f.isPerp || !f.expiry || f.markPrice <= 0) continue
    const futDays = (new Date(f.expiry).getTime() - now) / 86_400_000
    const dist = Math.abs(futDays - optsDays)
    if (dist < threshold && dist < bestDist) { bestDated = f; bestDist = dist }
  }
  if (bestDated) return { price: bestDated.markPrice, exchange: bestDated.exchange, isPerp: false }

  // Fall back to first available perp
  const perp = futures.find(f => f.isPerp && f.markPrice > 0)
  return perp ? { price: perp.markPrice, exchange: perp.exchange, isPerp: true } : null
}
