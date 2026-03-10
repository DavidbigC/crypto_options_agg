import { OptionsData, CombinedOptionContract } from '@/types/options'
import { applyFee, bestPrice } from './types'

export interface BoxLeg {
  action: 'buy' | 'sell'
  type: 'call' | 'put'
  strike: number
  price: number
  exchange: string | null
}

export interface BoxSpread {
  expiry: string
  k1: number
  k2: number
  type: 'long' | 'short'
  profit: number
  cost: number
  boxValue: number
  legs: BoxLeg[]
}

export function findBoxSpreads(
  optionsData: OptionsData,
  spotPrice: number,
  activeExchanges: Set<string>,
  minProfit = 0,
): BoxSpread[] {
  const results: BoxSpread[] = []

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const calls = (chainData as any).calls as CombinedOptionContract[] | undefined
    const puts  = (chainData as any).puts  as CombinedOptionContract[] | undefined
    if (!calls || !puts) continue

    const callsMap = new Map<number, CombinedOptionContract>()
    const putsMap  = new Map<number, CombinedOptionContract>()
    for (const c of calls) if (c.bestBid > 0 || c.bestAsk > 0) callsMap.set(c.strike, c)
    for (const p of puts)  if (p.bestBid > 0 || p.bestAsk > 0) putsMap.set(p.strike, p)

    // Only check strikes within ±40% of spot — deep ITM/OTM quotes are stale and unreliable
    const lo = spotPrice * 0.6
    const hi = spotPrice * 1.4
    const callStrikes = Array.from(callsMap.keys())
    const putStrikes = Array.from(putsMap.keys())
    const strikes = Array.from(
      new Set([...callStrikes, ...putStrikes])
    ).filter(s => s >= lo && s <= hi).sort((a, b) => a - b)

    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        const k1 = strikes[i], k2 = strikes[j]
        const c1 = callsMap.get(k1), c2 = callsMap.get(k2)
        const p1 = putsMap.get(k1),  p2 = putsMap.get(k2)
        if (!c1 || !c2 || !p1 || !p2) continue
        const boxValue = k2 - k1

        // Long box: buy C(K1) ask, sell C(K2) bid, buy P(K2) ask, sell P(K1) bid
        const lc1a = bestPrice(c1, 'buy',  activeExchanges)
        const lc2b = bestPrice(c2, 'sell', activeExchanges)
        const lp2a = bestPrice(p2, 'buy',  activeExchanges)
        const lp1b = bestPrice(p1, 'sell', activeExchanges)
        if (lc1a.val > 0 && lc2b.val > 0 && lp2a.val > 0 && lp1b.val > 0) {
          const cost   = applyFee(lc1a.val, 'buy',  lc1a.ex, spotPrice)
                       - applyFee(lc2b.val, 'sell', lc2b.ex, spotPrice)
                       + applyFee(lp2a.val, 'buy',  lp2a.ex, spotPrice)
                       - applyFee(lp1b.val, 'sell', lp1b.ex, spotPrice)
          const profit = boxValue - cost
          if (profit > minProfit) results.push({
            expiry, k1, k2, type: 'long', profit, cost, boxValue,
            legs: [
              { action: 'buy',  type: 'call', strike: k1, price: lc1a.val, exchange: lc1a.ex },
              { action: 'sell', type: 'call', strike: k2, price: lc2b.val, exchange: lc2b.ex },
              { action: 'buy',  type: 'put',  strike: k2, price: lp2a.val, exchange: lp2a.ex },
              { action: 'sell', type: 'put',  strike: k1, price: lp1b.val, exchange: lp1b.ex },
            ],
          })
        }

        // Short box: sell C(K1) bid, buy C(K2) ask, sell P(K2) bid, buy P(K1) ask
        const sc1b = bestPrice(c1, 'sell', activeExchanges)
        const sc2a = bestPrice(c2, 'buy',  activeExchanges)
        const sp2b = bestPrice(p2, 'sell', activeExchanges)
        const sp1a = bestPrice(p1, 'buy',  activeExchanges)
        if (sc1b.val > 0 && sc2a.val > 0 && sp2b.val > 0 && sp1a.val > 0) {
          const revenue = applyFee(sc1b.val, 'sell', sc1b.ex, spotPrice)
                        - applyFee(sc2a.val, 'buy',  sc2a.ex, spotPrice)
                        + applyFee(sp2b.val, 'sell', sp2b.ex, spotPrice)
                        - applyFee(sp1a.val, 'buy',  sp1a.ex, spotPrice)
          const profit  = revenue - boxValue
          if (profit > minProfit) results.push({
            expiry, k1, k2, type: 'short', profit, cost: revenue, boxValue,
            legs: [
              { action: 'sell', type: 'call', strike: k1, price: sc1b.val, exchange: sc1b.ex },
              { action: 'buy',  type: 'call', strike: k2, price: sc2a.val, exchange: sc2a.ex },
              { action: 'sell', type: 'put',  strike: k2, price: sp2b.val, exchange: sp2b.ex },
              { action: 'buy',  type: 'put',  strike: k1, price: sp1a.val, exchange: sp1a.ex },
            ],
          })
        }
      }
    }
  }
  return results
}
