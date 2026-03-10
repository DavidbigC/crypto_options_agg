import { OptionsData, CombinedOptionContract } from '@/types/options'
import { ArbOpportunity, FutureData, applyFee, bestPrice, calcApr, pickHedge } from './types'

export function findPCPArbs(
  optionsData: OptionsData,
  spotPrice: number,
  activeExchanges: Set<string>,
  futures: FutureData[] = [],
  minProfit = 0,
): ArbOpportunity[] {
  const results: ArbOpportunity[] = []
  const lo = spotPrice * 0.6
  const hi = spotPrice * 1.4

  for (const [expiry, chainData] of Object.entries(optionsData.data)) {
    const chain = chainData as any
    const fwd = chain.forwardPrice > 0 ? chain.forwardPrice : spotPrice
    const hedge = pickHedge(expiry, futures)
    const hedgePrice = hedge?.price ?? fwd
    const daysToExpiry = Math.max(1, (new Date(expiry).getTime() - Date.now()) / 86_400_000)

    // Index calls and puts by strike
    const callsByStrike = new Map<number, CombinedOptionContract>()
    const putsByStrike  = new Map<number, CombinedOptionContract>()
    for (const c of (chain.calls ?? []) as CombinedOptionContract[]) {
      if (c.strike >= lo && c.strike <= hi) callsByStrike.set(c.strike, c)
    }
    for (const p of (chain.puts ?? []) as CombinedOptionContract[]) {
      if (p.strike >= lo && p.strike <= hi) putsByStrike.set(p.strike, p)
    }

    for (const [strike, call] of Array.from(callsByStrike.entries())) {
      const put = putsByStrike.get(strike)
      if (!put) continue

      const theoreticalCPDiff = fwd - strike   // PCP: C - P = F - K

      // Conversion: sell C + buy P. Arb if bid(C) - ask(P) > F - K.
      // Needs a buy-futures hedge at F. Profit = options credit - fwd value.
      const callBid = bestPrice(call, 'sell', activeExchanges)
      const putAsk  = bestPrice(put,  'buy',  activeExchanges)
      if (callBid.val > 0 && putAsk.val > 0) {
        const received = applyFee(callBid.val, 'sell', callBid.ex, spotPrice)
        const paid     = applyFee(putAsk.val,  'buy',  putAsk.ex,  spotPrice)
        const profit   = (received - paid) - theoreticalCPDiff
        if (profit > minProfit) {
          const collateral = 0.1 * spotPrice + callBid.val   // short call margin estimate
          results.push({
            strategy: 'pcp_conversion',
            expiry, profit,
            apr: calcApr(profit, collateral, daysToExpiry),
            collateral,
            legs: [
              { action: 'sell',  type: 'call',   strike, expiry, qty: 1, price: callBid.val, exchange: callBid.ex },
              { action: 'buy',   type: 'put',    strike, expiry, qty: 1, price: putAsk.val,  exchange: putAsk.ex  },
              { action: 'buy',   type: 'future', strike: 0, expiry, qty: 1, price: hedgePrice, exchange: hedge?.exchange ?? callBid.ex },
            ],
          })
        }
      }

      // Reversal: buy C + sell P. Arb if F - K > ask(C) - bid(P).
      // Needs a sell-futures hedge at F. Profit = fwd value - options net cost.
      const callAsk = bestPrice(call, 'buy',  activeExchanges)
      const putBid  = bestPrice(put,  'sell', activeExchanges)
      if (callAsk.val > 0 && putBid.val > 0) {
        const paid     = applyFee(callAsk.val, 'buy',  callAsk.ex, spotPrice)
        const received = applyFee(putBid.val,  'sell', putBid.ex,  spotPrice)
        const profit   = theoreticalCPDiff - (paid - received)
        if (profit > minProfit) {
          const collateral = 0.1 * spotPrice + putBid.val   // short put margin estimate
          results.push({
            strategy: 'pcp_reversal',
            expiry, profit,
            apr: calcApr(profit, collateral, daysToExpiry),
            collateral,
            legs: [
              { action: 'buy',  type: 'call',   strike, expiry, qty: 1, price: callAsk.val, exchange: callAsk.ex },
              { action: 'sell', type: 'put',    strike, expiry, qty: 1, price: putBid.val,  exchange: putBid.ex  },
              { action: 'sell', type: 'future', strike: 0, expiry, qty: 1, price: hedgePrice, exchange: hedge?.exchange ?? callAsk.ex },
            ],
          })
        }
      }
    }
  }
  return results
}
