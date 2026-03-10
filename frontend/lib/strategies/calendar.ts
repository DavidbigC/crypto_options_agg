import { OptionsData, CombinedOptionContract } from '@/types/options'
import { ArbOpportunity, applyFee, bestPrice, calcApr } from './types'

export function findCalendarArbs(
  optionsData: OptionsData,
  spotPrice: number,
  activeExchanges: Set<string>,
  minProfit = 0,
): ArbOpportunity[] {
  const results: ArbOpportunity[] = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  // Group by strike + type across expiries
  const groups = new Map<string, Array<CombinedOptionContract & { expiry: string }>>()
  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    for (const [optType, contracts] of [
      ['call', (chainData as any).calls],
      ['put',  (chainData as any).puts],
    ] as [string, CombinedOptionContract[] | undefined][]) {
      if (!contracts) continue
      for (const c of contracts) {
        if (c.strike < lo || c.strike > hi) continue
        const key = `${c.strike}|${optType}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push({ ...c, expiry })
      }
    }
  }

  for (const [key, entries] of Array.from(groups.entries())) {
    if (entries.length < 2) continue
    const optType = key.split('|')[1] as 'call' | 'put'
    entries.sort((a, b) => new Date(a.expiry).getTime() - new Date(b.expiry).getTime())

    for (let i = 0; i + 1 < entries.length; i++) {
      const near = entries[i]
      const far  = entries[i + 1]
      const bidNear = bestPrice(near, 'sell', activeExchanges)
      const askFar  = bestPrice(far,  'buy',  activeExchanges)
      if (bidNear.val <= 0 || askFar.val <= 0) continue

      const received = applyFee(bidNear.val, 'sell', bidNear.ex, spotPrice)
      const paid     = applyFee(askFar.val,  'buy',  askFar.ex,  spotPrice)
      const profit   = received - paid
      if (profit > minProfit) {
        const daysToNear = Math.max(1, (new Date(near.expiry).getTime() - Date.now()) / 86_400_000)
        results.push({
          strategy: 'calendar_arb',
          expiry: near.expiry,
          profit, apr: calcApr(profit, askFar.val, daysToNear), collateral: askFar.val,
          legs: [
            { action: 'sell', type: optType, strike: near.strike, expiry: near.expiry, qty: 1, price: bidNear.val, exchange: bidNear.ex },
            { action: 'buy',  type: optType, strike: far.strike,  expiry: far.expiry,  qty: 1, price: askFar.val,  exchange: askFar.ex  },
          ],
        })
      }
    }
  }
  return results
}
