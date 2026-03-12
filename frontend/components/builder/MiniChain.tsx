'use client'

import { useState, useRef, useEffect } from 'react'
import classNames from 'classnames'
import { Exchange, Leg, OptionsData, OptionContract, CombinedOptionContract, CONTRACT_SIZES } from '@/types/options'
import GreekTh from '@/components/GreekTh'
import { EX_BADGE, EX_LABEL as EX_LABEL_MAP } from '@/lib/exchangeColors'
import { filterExpirations } from '@/lib/filterExpirations'

interface MiniChainProps {
  exchange: Exchange
  coin: string
  onCoinChange: (coin: 'BTC' | 'ETH' | 'SOL') => void
  optionsData: OptionsData | null
  spotPrice: number
  onAddLeg: (leg: Omit<Leg, 'id'>) => void
}

const COINS = ['BTC', 'ETH', 'SOL'] as const
type ExchangeKey = 'bybit' | 'okx' | 'deribit' | 'binance'
const ALL_EXCHANGES: ExchangeKey[] = ['bybit', 'okx', 'deribit', 'binance']
const EX_COLOR: Record<ExchangeKey, string> = EX_BADGE as Record<ExchangeKey, string>
const EX_LABEL: Record<ExchangeKey, string> = EX_LABEL_MAP as Record<ExchangeKey, string>

const EX_SHORT: Record<string, string> = { bybit: 'B', okx: 'O', deribit: 'D', binance: 'N' }

function ExBadge({ ex }: { ex: 'bybit' | 'okx' | 'deribit' | 'binance' | null | undefined }) {
  return (
    <span className={classNames('inline-block mx-0.5 w-[14px] text-center rounded text-[8px] font-bold', ex ? EX_BADGE[ex] : 'invisible')}>
      {ex ? (EX_SHORT[ex] ?? ex[0].toUpperCase()) : ''}
    </span>
  )
}

export default function MiniChain({ exchange, coin, onCoinChange, optionsData, spotPrice, onAddLeg }: MiniChainProps) {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('')
  const [showAll, setShowAll] = useState(false)
  const [activeExchanges, setActiveExchanges] = useState<Set<ExchangeKey>>(new Set(ALL_EXCHANGES))
  const atmRowRef = useRef<HTMLTableRowElement>(null)

  const toggleExchange = (ex: ExchangeKey) => {
    setActiveExchanges(prev => {
      const next = new Set(prev)
      if (next.has(ex)) {
        if (next.size === 1) return prev
        next.delete(ex)
      } else {
        next.add(ex)
      }
      return next
    })
  }

  const expirations = filterExpirations(optionsData?.expirations ?? [])
  const expiry = selectedExpiry || expirations[0] || ''
  const chainData = optionsData?.data[expiry]

  const allStrikes = Array.from(new Set([
    ...(chainData?.calls.map(c => c.strike) ?? []),
    ...(chainData?.puts.map(p => p.strike) ?? []),
  ])).sort((a, b) => a - b)

  const isCombined = exchange === 'combined'

  type AnyContract = OptionContract & CombinedOptionContract

  const callsMap = new Map(chainData?.calls.map(c => [c.strike, c as unknown as AnyContract]) ?? [])
  const putsMap  = new Map(chainData?.puts.map(p => [p.strike, p as unknown as AnyContract]) ?? [])

  const atmStrike = allStrikes.length > 0
    ? allStrikes.reduce((prev, curr) =>
        Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev, allStrikes[0])
    : 0

  const atmIndex = allStrikes.indexOf(atmStrike)
  const visibleStrikes = showAll
    ? allStrikes
    : allStrikes.slice(Math.max(0, atmIndex - 5), atmIndex + 6)

  useEffect(() => {
    atmRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [expiry, atmStrike])

  const bestFiltered = (c: AnyContract, side: 'buy' | 'sell'): { val: number; ex: ExchangeKey | null } => {
    if (!isCombined || !c.prices) return { val: side === 'buy' ? (c.ask ?? 0) : (c.bid ?? 0), ex: null }
    let bestVal = 0
    let bestEx: ExchangeKey | null = null
    for (const ex of Array.from(activeExchanges)) {
      const prices = c.prices[ex]
      if (!prices) continue
      const raw = side === 'buy' ? prices.ask : prices.bid
      if (!raw || raw === 0) continue
      if (side === 'sell' && raw > bestVal) { bestVal = raw; bestEx = ex }
      if (side === 'buy'  && (bestVal === 0 || raw < bestVal)) { bestVal = raw; bestEx = ex }
    }
    return { val: bestVal, ex: bestEx }
  }

  const getBid = (c: AnyContract) => isCombined ? bestFiltered(c, 'sell').val : c.bid
  const getAsk = (c: AnyContract) => isCombined ? bestFiltered(c, 'buy').val  : c.ask

  const toUSD = (price: number) => {
    if (price === 0) return 0
    if (!isCombined && exchange === 'okx' && spotPrice > 0) return Math.round(price * spotPrice)
    return Math.round(price)
  }

  const fmtUSD = (price: number) => {
    const v = toUSD(price)
    return v > 0 ? v.toLocaleString() : '--'
  }

  const fmtDelta = (v: number | undefined) => (v != null && v !== 0) ? v.toFixed(2) : '--'
  const fmtGamma = (v: number | undefined) => (v != null && v !== 0) ? v.toFixed(5) : '--'
  const fmtTheta = (v: number | undefined) => (v != null && v !== 0) ? v.toFixed(1) : '--'
  const fmtVega  = (v: number | undefined) => (v != null && v !== 0) ? v.toFixed(1) : '--'
  const fmtVol   = (v: number | undefined) => (v != null && v !== 0) ? (v * 100).toFixed(0) + '%' : '--'

  const isCallITM = (strike: number) => strike < spotPrice
  const isPutITM  = (strike: number) => strike > spotPrice

  const daysToExpiry = expiry
    ? Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)
    : 0

  const fmtAPR = (bidRaw: number, collateral: number): string => {
    if (!bidRaw || bidRaw <= 0 || daysToExpiry <= 0 || collateral <= 0) return '--'
    const bidUSD = toUSD(bidRaw)
    return ((bidUSD / collateral) * (365 / daysToExpiry) * 100).toFixed(1) + '%'
  }

  const makeLeg = (contract: AnyContract, side: 'buy' | 'sell', type: 'call' | 'put', legExchange?: Exchange): Omit<Leg, 'id'> => {
    const filtered = isCombined ? bestFiltered(contract, side) : null
    const resolvedExchange = (filtered?.ex ?? legExchange ?? exchange) as Exchange
    // contractSize reflects actual exchange contract size (e.g. OKX BTC = 0.1 BTC per contract)
    // entryPrice is always the per-BTC-underlying USD price (matching chain display)
    // P&L cost must then multiply entryPrice * contractSize (done in PnLChart)
    const cs = CONTRACT_SIZES[resolvedExchange]?.[coin] ?? 1
    const rawPrice = filtered ? filtered.val : (side === 'buy' ? getAsk(contract) : getBid(contract))
    // For non-combined OKX, prices are in BTC — convert to USD
    const priceUSD = (!isCombined && resolvedExchange === 'okx' && spotPrice > 0)
      ? rawPrice * spotPrice
      : rawPrice
    return {
      exchange: resolvedExchange,
      coin,
      symbol: contract.symbol ?? '',
      expiry,
      strike: contract.strike,
      type,
      side,
      qty: 1,
      entryPrice: priceUSD,
      markVol: contract.markVol || contract.impliedVolatility || 0.5,
      contractSize: cs,
      enabled: true,
    }
  }

  return (
    <div className="card flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Options Chain</h2>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-ink-2 uppercase">{exchange}</span>
          {isCombined && (
            <div className="flex items-center gap-0.5">
              {ALL_EXCHANGES.map(ex => (
                <button
                  key={ex}
                  onClick={() => toggleExchange(ex)}
                  className={classNames('px-1 py-0.5 rounded text-[9px] font-bold transition-opacity', EX_COLOR[ex], {
                    'text-white opacity-100': activeExchanges.has(ex),
                    'opacity-25': !activeExchanges.has(ex),
                  })}
                >
                  {EX_LABEL[ex]}
                </button>
              ))}
            </div>
          )}
          {allStrikes.length > 0 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="px-2 py-0.5 rounded border border-rim text-[10px] text-ink-2 hover:text-ink hover:border-ink-3"
            >
              {showAll ? '±5 strikes' : `Show all ${allStrikes.length}`}
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {COINS.map(c => (
            <button key={c} onClick={() => onCoinChange(c)}
              className={classNames('px-2 py-0.5 rounded text-xs font-medium', {
                'bg-tone text-white': coin === c,
                'text-ink-2 hover:text-ink': coin !== c,
              })}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Expiry tabs */}
      <div className="flex flex-wrap gap-1">
        {expirations.map(exp => (
          <button key={exp} onClick={() => setSelectedExpiry(exp)}
            className={classNames('px-2 py-0.5 rounded text-[10px] font-mono border', {
              'bg-tone text-white border-tone': expiry === exp,
              'text-ink-2 border-rim hover:border-ink-3': expiry !== exp,
            })}>
            {new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </button>
        ))}
      </div>

      {!chainData ? (
        <div className="text-xs text-ink-3 text-center py-8">Loading…</div>
      ) : (
        <div className="overflow-y-auto max-h-[420px]">
          <table className="w-full text-[11px] table-fixed">
            <colgroup>
              {/* CALLS: ITM V Θ Γ Δ bIV mIV aIV Bid APR Ask */}
              <col className="w-8" />
              <col className="w-10" />
              <col className="w-14" />
              <col className="w-16" />
              <col className="w-10" />
              <col className="w-[42px]" />
              <col className="w-[42px]" />
              <col className="w-[42px]" />
              <col className="w-[72px]" />
              <col className="w-[48px]" />
              <col className="w-[72px]" />
              {/* Strike */}
              <col className="w-16" />
              {/* PUTS: Ask Bid APR aIV mIV bIV Δ Γ Θ V ITM */}
              <col className="w-[72px]" />
              <col className="w-[72px]" />
              <col className="w-[48px]" />
              <col className="w-[42px]" />
              <col className="w-[42px]" />
              <col className="w-[42px]" />
              <col className="w-10" />
              <col className="w-16" />
              <col className="w-14" />
              <col className="w-10" />
              <col className="w-8" />
            </colgroup>
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-rim text-[9px] text-ink-3">
                <th colSpan={11} className="text-center pb-0.5 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20">CALLS</th>
                <th />
                <th colSpan={11} className="text-center pb-0.5 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20">PUTS</th>
              </tr>
              <tr className="border-b border-rim text-ink-2 text-[10px]">
                <th className="py-1 text-right pr-1 font-medium">ITM</th>
                <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="py-1 pr-1 text-right" />
                <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="py-1 pr-1 text-right" />
                <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="py-1 pr-1 text-right" />
                <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="py-1 pr-1 text-right" />
                <th className="py-1 text-right pr-1 font-medium text-ink-3">bIV</th>
                <th className="py-1 text-right pr-1 font-medium text-ink-3">mIV</th>
                <th className="py-1 text-right pr-1 font-medium text-ink-3">aIV</th>
                <th className="py-1 text-right pr-1 font-medium">Bid</th>
                <th className="py-1 text-right pr-1 font-medium text-amber-600 dark:text-amber-400">APR</th>
                <th className="py-1 text-right pr-2 font-medium">Ask</th>
                <th className="py-1 text-center font-semibold text-ink">Strike</th>
                <th className="py-1 text-left pl-2 font-medium">Ask</th>
                <th className="py-1 text-left font-medium">Bid</th>
                <th className="py-1 text-left font-medium text-amber-600 dark:text-amber-400">APR</th>
                <th className="py-1 text-left font-medium text-ink-3">aIV</th>
                <th className="py-1 text-left font-medium text-ink-3">mIV</th>
                <th className="py-1 text-left font-medium text-ink-3">bIV</th>
                <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="py-1 text-left" />
                <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="py-1 text-left" />
                <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="py-1 text-left" />
                <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="py-1 text-left" />
                <th className="py-1 text-left font-medium">ITM</th>
              </tr>
            </thead>
            <tbody>
              {visibleStrikes.map(strike => {
                const call = callsMap.get(strike)
                const put  = putsMap.get(strike)
                const isATM = strike === atmStrike
                const callBidF = call ? bestFiltered(call, 'sell') : { val: 0, ex: null }
                const callAskF = call ? bestFiltered(call, 'buy')  : { val: 0, ex: null }
                const putBidF  = put  ? bestFiltered(put,  'sell') : { val: 0, ex: null }
                const putAskF  = put  ? bestFiltered(put,  'buy')  : { val: 0, ex: null }
                const callBid = callBidF.val
                const callAsk = callAskF.val
                const putBid  = putBidF.val
                const putAsk  = putAskF.val
                return (
                  <tr
                    key={strike}
                    ref={isATM ? atmRowRef : undefined}
                    className={classNames('border-b hover:bg-muted', {
                      'bg-amber-50 dark:bg-amber-950/30': isATM,
                      'border-rim': true,
                    })}
                  >
                    {/* Call ITM */}
                    <td className="py-0.5 pr-1 text-right text-[10px] text-tone font-medium">
                      {isCallITM(strike) ? 'ITM' : ''}
                    </td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtVega(call?.vega)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtTheta(call?.theta)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtGamma(call?.gamma)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-2">{fmtDelta(call?.delta)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtVol(call?.bidVol)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtVol(call?.markVol || call?.impliedVolatility)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-3">{fmtVol(call?.askVol)}</td>
                    {/* Call Bid (sell) */}
                    <td className="py-0.5 pr-1 text-right">
                      {call && callBid > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(call, 'sell', 'call'))}
                          className="text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 px-1 rounded inline-flex items-center"
                        >
                          {fmtUSD(callBid)}
                          {isCombined && <ExBadge ex={callBidF.ex} />}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    {/* Call APR */}
                    <td className={classNames('py-0.5 pr-1 text-right text-amber-600 dark:text-amber-400 font-mono text-[10px]', {
                      'opacity-30': isCallITM(strike),
                    })}>
                      {fmtAPR(callBid, spotPrice)}
                    </td>
                    {/* Call Ask (buy) */}
                    <td className="py-0.5 pr-2 text-right">
                      {call && callAsk > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(call, 'buy', 'call'))}
                          className="text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 px-1 rounded font-medium inline-flex items-center"
                        >
                          {fmtUSD(callAsk)}
                          {isCombined && <ExBadge ex={callAskF.ex} />}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>

                    {/* Strike */}
                    <td className={classNames('py-0.5 text-center font-mono font-semibold text-[11px] px-2', {
                      'text-tone': isATM, 'text-ink': !isATM,
                    })}>
                      {strike.toLocaleString()}
                    </td>

                    {/* Put Ask (buy) */}
                    <td className="py-0.5 pl-2 text-left">
                      {put && putAsk > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(put, 'buy', 'put'))}
                          className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-1 rounded font-medium inline-flex items-center"
                        >
                          {isCombined && <ExBadge ex={putAskF.ex} />}
                          {fmtUSD(putAsk)}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    {/* Put Bid (sell) */}
                    <td className="py-0.5 text-left">
                      {put && putBid > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(put, 'sell', 'put'))}
                          className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-1 rounded inline-flex items-center"
                        >
                          {isCombined && <ExBadge ex={putBidF.ex} />}
                          {fmtUSD(putBid)}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    {/* Put APR */}
                    <td className={classNames('py-0.5 text-left text-amber-600 dark:text-amber-400 font-mono text-[10px]', {
                      'opacity-30': isPutITM(strike),
                    })}>
                      {fmtAPR(putBid, strike)}
                    </td>
                    <td className="py-0.5 text-left text-ink-3">{fmtVol(put?.askVol)}</td>
                    <td className="py-0.5 text-left text-ink-3">{fmtVol(put?.markVol || put?.impliedVolatility)}</td>
                    <td className="py-0.5 text-left text-ink-3">{fmtVol(put?.bidVol)}</td>
                    <td className="py-0.5 text-left text-ink-2">{fmtDelta(put?.delta)}</td>
                    <td className="py-0.5 text-left text-ink-3">{fmtGamma(put?.gamma)}</td>
                    <td className="py-0.5 text-left text-ink-3">{fmtTheta(put?.theta)}</td>
                    <td className="py-0.5 text-left text-ink-3">{fmtVega(put?.vega)}</td>
                    {/* Put ITM */}
                    <td className="py-0.5 text-left text-[10px] text-tone font-medium">
                      {isPutITM(strike) ? 'ITM' : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-ink-3">Click Ask to buy · Click Bid to sell · Prices in USD</p>
    </div>
  )
}
