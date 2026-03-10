import { OptionsData, CombinedOptionContract } from '@/types/options'
import { ArbOpportunity, applyFee, bestPrice, calcApr } from './types'

export function findVerticalArbs(
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

      // Check adjacent pairs only — avoids noise from stale quotes across wide ranges
      for (let i = 0; i + 1 < sorted.length; i++) {
        const cLow  = sorted[i]
        const cHigh = sorted[i + 1]

        if (optType === 'call') {
          // C(K_low) >= C(K_high): violation if ask(K_low) < bid(K_high)
          const bAsk = bestPrice(cLow,  'buy',  activeExchanges)
          const sBid = bestPrice(cHigh, 'sell', activeExchanges)
          if (bAsk.val <= 0 || sBid.val <= 0) continue
          const paid     = applyFee(bAsk.val, 'buy',  bAsk.ex, spotPrice)
          const received = applyFee(sBid.val, 'sell', sBid.ex, spotPrice)
          const profit   = received - paid
          if (profit > minProfit) results.push({
            strategy: 'call_monotonicity', expiry,
            profit, apr: calcApr(profit, bAsk.val, daysToExpiry), collateral: bAsk.val,
            legs: [
              { action: 'buy',  type: 'call', strike: cLow.strike,  expiry, qty: 1, price: bAsk.val, exchange: bAsk.ex },
              { action: 'sell', type: 'call', strike: cHigh.strike, expiry, qty: 1, price: sBid.val, exchange: sBid.ex },
            ],
          })
        } else {
          // P(K_high) >= P(K_low): violation if bid(K_low) > ask(K_high)
          const sBid = bestPrice(cLow,  'sell', activeExchanges)
          const bAsk = bestPrice(cHigh, 'buy',  activeExchanges)
          if (sBid.val <= 0 || bAsk.val <= 0) continue
          const received = applyFee(sBid.val, 'sell', sBid.ex, spotPrice)
          const paid     = applyFee(bAsk.val, 'buy',  bAsk.ex, spotPrice)
          const profit   = received - paid
          if (profit > minProfit) results.push({
            strategy: 'put_monotonicity', expiry,
            profit, apr: calcApr(profit, bAsk.val, daysToExpiry), collateral: bAsk.val,
            legs: [
              { action: 'sell', type: 'put', strike: cLow.strike,  expiry, qty: 1, price: sBid.val, exchange: sBid.ex },
              { action: 'buy',  type: 'put', strike: cHigh.strike, expiry, qty: 1, price: bAsk.val, exchange: bAsk.ex },
            ],
          })
        }
      }
    }
  }
  return results
}
