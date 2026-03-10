import { OptionsData, CombinedOptionContract } from '@/types/options'
import { ArbOpportunity, applyFee, bestPrice, calcApr } from './types'

export function findButterflyArbs(
  optionsData: OptionsData,
  spotPrice: number,
  activeExchanges: Set<string>,
  minProfit = 0,
): ArbOpportunity[] {
  const results: ArbOpportunity[] = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const daysToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / 86_400_000)

    for (const [optType, contracts] of [
      ['call', (chainData as any).calls] as const,
      ['put',  (chainData as any).puts]  as const,
    ]) {
      if (!contracts) continue
      const sorted = (contracts as CombinedOptionContract[])
        .filter(c => c.strike >= lo && c.strike <= hi)
        .sort((a, b) => a.strike - b.strike)

      for (let i = 0; i + 2 < sorted.length; i++) {
        const c1 = sorted[i], c2 = sorted[i + 1], c3 = sorted[i + 2]
        // Only equal-wing butterflies are riskless; asymmetric wings leave a net
        // delta at expiry (payoff = 2×K2−K1−K3 ≠ 0) that can exceed the credit received.
        const leftGap = c2.strike - c1.strike
        const rightGap = c3.strike - c2.strike
        if (Math.abs(leftGap - rightGap) / leftGap > 0.05) continue   // >5% asymmetry → skip

        const w1 = bestPrice(c1, 'buy',  activeExchanges)
        const m2 = bestPrice(c2, 'sell', activeExchanges)
        const w3 = bestPrice(c3, 'buy',  activeExchanges)
        if (w1.val <= 0 || m2.val <= 0 || w3.val <= 0) continue

        const paid1 = applyFee(w1.val, 'buy',  w1.ex, spotPrice)
        const recv2 = applyFee(m2.val, 'sell', m2.ex, spotPrice) * 2
        const paid3 = applyFee(w3.val, 'buy',  w3.ex, spotPrice)
        const profit = -(paid1 - recv2 + paid3)
        if (profit > minProfit) {
          // Collateral = wing width (exchange spread margin requirement = max possible loss)
          const collateral = leftGap  // K2-K1 = K3-K2 for equal wings
          results.push({
            strategy: optType === 'call' ? 'call_butterfly' : 'put_butterfly',
            expiry, profit, apr: calcApr(profit, collateral, daysToExpiry), collateral,
            legs: [
              { action: 'buy',  type: optType as 'call'|'put', strike: c1.strike, expiry, qty: 1, price: w1.val, exchange: w1.ex },
              { action: 'sell', type: optType as 'call'|'put', strike: c2.strike, expiry, qty: 2, price: m2.val, exchange: m2.ex },
              { action: 'buy',  type: optType as 'call'|'put', strike: c3.strike, expiry, qty: 1, price: w3.val, exchange: w3.ex },
            ],
          })
        }
      }
    }
  }
  return results
}
