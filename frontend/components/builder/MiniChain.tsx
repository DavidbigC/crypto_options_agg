'use client'

import { useState, useRef, useEffect } from 'react'
import classNames from 'classnames'
import { Exchange, Leg, OptionsData, OptionContract, CombinedOptionContract, CONTRACT_SIZES } from '@/types/options'
import GreekTh from '@/components/GreekTh'

interface MiniChainProps {
  exchange: Exchange
  coin: string
  onCoinChange: (coin: 'BTC' | 'ETH' | 'SOL') => void
  optionsData: OptionsData | null
  spotPrice: number
  onAddLeg: (leg: Omit<Leg, 'id'>) => void
}

const COINS = ['BTC', 'ETH', 'SOL'] as const

function ExBadge({ ex }: { ex: 'bybit' | 'okx' | 'deribit' | null | undefined }) {
  if (!ex) return null
  return (
    <span className={classNames('ml-0.5 px-1 rounded text-white text-[8px] font-bold', {
      'bg-orange-500': ex === 'bybit',
      'bg-zinc-700':   ex === 'okx',
      'bg-blue-600':   ex === 'deribit',
    })}>
      {ex === 'bybit' ? 'B' : ex === 'okx' ? 'O' : 'D'}
    </span>
  )
}

export default function MiniChain({ exchange, coin, onCoinChange, optionsData, spotPrice, onAddLeg }: MiniChainProps) {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('')
  const [showAll, setShowAll] = useState(false)
  const atmRowRef = useRef<HTMLTableRowElement>(null)

  const expirations = optionsData?.expirations ?? []
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

  const getBid = (c: AnyContract) => isCombined ? (c.bestBid ?? 0) : c.bid
  const getAsk = (c: AnyContract) => isCombined ? (c.bestAsk ?? 0) : c.ask

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

  const makeLeg = (contract: AnyContract, side: 'buy' | 'sell', type: 'call' | 'put', legExchange?: Exchange): Omit<Leg, 'id'> => {
    const cs = CONTRACT_SIZES[legExchange ?? exchange]?.[coin] ?? 1
    const rawPrice = side === 'buy' ? getAsk(contract) : getBid(contract)
    return {
      exchange: legExchange ?? exchange,
      coin,
      symbol: contract.symbol ?? '',
      expiry,
      strike: contract.strike,
      type,
      side,
      qty: 1,
      entryPrice: rawPrice * cs,
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
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-rim text-[9px] text-ink-3">
                <th colSpan={8} className="text-center pb-0.5 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20">CALLS</th>
                <th />
                <th colSpan={8} className="text-center pb-0.5 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20">PUTS</th>
              </tr>
              <tr className="border-b border-rim text-ink-2 text-[10px]">
                <th className="py-1 text-right pr-1 font-medium">ITM</th>
                <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="py-1 pr-1" />
                <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="py-1 pr-1" />
                <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="py-1 pr-1" />
                <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="py-1 pr-1" />
                <th className="py-1 text-right pr-1 font-medium">{isCombined ? 'IV' : 'IV%'}</th>
                <th className="py-1 text-right pr-1 font-medium">Bid</th>
                <th className="py-1 text-right pr-2 font-medium">Ask</th>
                <th className="py-1 text-center font-semibold text-ink">Strike</th>
                <th className="py-1 text-left pl-2 font-medium">Ask</th>
                <th className="py-1 text-left font-medium">Bid</th>
                <th className="py-1 text-left font-medium">{isCombined ? 'IV' : 'IV%'}</th>
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
                const callBid = call ? getBid(call) : 0
                const callAsk = call ? getAsk(call) : 0
                const putBid  = put  ? getBid(put)  : 0
                const putAsk  = put  ? getAsk(put)  : 0
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
                    <td className="py-0.5 pr-1 text-right text-ink-3">
                      {!isCombined ? fmtVol(call?.markVol || call?.impliedVolatility) : '--'}
                    </td>
                    {/* Call Bid (sell) */}
                    <td className="py-0.5 pr-1 text-right">
                      {call && callBid > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(call, 'sell', 'call', isCombined ? call.bestBidEx ?? undefined : undefined))}
                          className="text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 px-1 rounded inline-flex items-center"
                        >
                          {fmtUSD(callBid)}
                          {isCombined && <ExBadge ex={call.bestBidEx} />}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    {/* Call Ask (buy) */}
                    <td className="py-0.5 pr-2 text-right">
                      {call && callAsk > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(call, 'buy', 'call', isCombined ? call.bestAskEx ?? undefined : undefined))}
                          className="text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 px-1 rounded font-medium inline-flex items-center"
                        >
                          {fmtUSD(callAsk)}
                          {isCombined && <ExBadge ex={call.bestAskEx} />}
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
                          onClick={() => onAddLeg(makeLeg(put, 'buy', 'put', isCombined ? put.bestAskEx ?? undefined : undefined))}
                          className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-1 rounded font-medium inline-flex items-center"
                        >
                          {fmtUSD(putAsk)}
                          {isCombined && <ExBadge ex={put.bestAskEx} />}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    {/* Put Bid (sell) */}
                    <td className="py-0.5 text-left">
                      {put && putBid > 0 ? (
                        <button
                          onClick={() => onAddLeg(makeLeg(put, 'sell', 'put', isCombined ? put.bestBidEx ?? undefined : undefined))}
                          className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-1 rounded inline-flex items-center"
                        >
                          {fmtUSD(putBid)}
                          {isCombined && <ExBadge ex={put.bestBidEx} />}
                        </button>
                      ) : <span className="text-ink-3 px-1">--</span>}
                    </td>
                    <td className="py-0.5 text-left text-ink-3">
                      {!isCombined ? fmtVol(put?.markVol || put?.impliedVolatility) : '--'}
                    </td>
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
