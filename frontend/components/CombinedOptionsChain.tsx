'use client'

import { useState } from 'react'
import classNames from 'classnames'
import { CombinedOptionContract, CombinedOptionsChainData } from '@/types/options'
import { BoxSpread } from '@/lib/strategies'
import { calcBreakEven } from '@/lib/blackScholes'
import GreekTh from '@/components/GreekTh'
import { EX_BADGE, EX_LABEL as EX_LABEL_MAP } from '@/lib/exchangeColors'

const TAKER_FEE = 0.0003
const FEE_CAP: Record<string, number> = {
  bybit:   0.07,
  okx:     0.07,
  deribit: 0.125,
}

type ExchangeKey = 'bybit' | 'okx' | 'deribit'

interface CombinedOptionsChainProps {
  data: CombinedOptionsChainData
  spotPrice: number
  expiration: string
  lastUpdated?: Date | null
  boxSpreads?: BoxSpread[]
  activeExchanges?: Set<ExchangeKey>
  onToggleExchange?: (ex: ExchangeKey) => void
}

interface CombinedRowProps {
  call?: CombinedOptionContract
  put?: CombinedOptionContract
  strike: number
  spotPrice: number
  isATM: boolean
  feesOn: boolean
  activeExchanges: Set<ExchangeKey>
  boxForStrike?: BoxSpread[]
}

function ExBadge({ ex }: { ex: 'bybit' | 'okx' | 'deribit' | null | undefined }) {
  return (
    <span className={classNames('inline-block ml-1 w-[26px] text-center rounded text-[9px] font-bold', ex ? EX_BADGE[ex] : 'invisible')}>
      {ex ? EX_LABEL_MAP[ex] : ''}
    </span>
  )
}

function CombinedRow({ call, put, strike, spotPrice, isATM, feesOn, activeExchanges, boxForStrike }: CombinedRowProps) {
  const withFee = (price: number, side: 'buy' | 'sell', ex: string) => {
    if (!feesOn || price === 0) return price
    const cap = FEE_CAP[ex] ?? 0.07
    const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
    return side === 'buy' ? price + fee : price - fee
  }

  const bestFiltered = (contract: CombinedOptionContract, side: 'buy' | 'sell') => {
    const prices = contract.prices
    let bestVal = 0
    let bestEx: ExchangeKey | null = null
    for (const ex of activeExchanges) {
      const raw = side === 'sell' ? prices[ex]?.bid : prices[ex]?.ask
      if (!raw || raw === 0) continue
      if (side === 'sell' && raw > bestVal) { bestVal = raw; bestEx = ex }
      if (side === 'buy'  && (bestVal === 0 || raw < bestVal)) { bestVal = raw; bestEx = ex }
    }
    return { val: bestVal, ex: bestEx }
  }

  const fmt = (contract: CombinedOptionContract | undefined, side: 'buy' | 'sell') => {
    if (!contract) return { price: '--', ex: null as ExchangeKey | null }
    const { val, ex } = bestFiltered(contract, side)
    if (!val || !ex) return { price: '--', ex: null as ExchangeKey | null }
    return { price: withFee(val, side, ex).toFixed(2), ex }
  }
  const fmtG = (v: number | undefined | null, dp = 2) => !v ? '--' : v.toFixed(dp)
  const fmtBE = (theta: number | undefined, gamma: number | undefined): string => {
    if (!theta || !gamma) return '--'
    const be = calcBreakEven(theta, gamma)
    return be ? '$' + Math.round(be).toLocaleString() : '--'
  }

  const isITM = (type: 'call' | 'put') =>
    type === 'call' ? strike < spotPrice : strike > spotPrice

  return (
    <tr className={classNames('border-b hover:bg-muted text-xs', {
      'bg-amber-50 dark:bg-amber-950/30': isATM,
      'border-rim': true,
    })}>
      {/* CALLS */}
      <td className="px-2 py-1 text-right text-ink-2">
        {(() => { const r = fmt(call, 'sell'); return <><span>{r.price}</span><ExBadge ex={r.ex} /></> })()}
      </td>
      <td className="px-2 py-1 text-right text-ink-2">
        {(() => { const r = fmt(call, 'buy'); return <><span>{r.price}</span><ExBadge ex={r.ex} /></> })()}
      </td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.delta) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.theta) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.vega) : '--'}</td>
      <td className="px-2 py-1 text-right text-violet-600 dark:text-violet-400 text-[11px]">
        {fmtBE(call?.theta, call?.gamma)}
      </td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.bidVol  ? (call.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.markVol ? (call.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.askVol  ? (call.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-2 py-1 text-right text-xs text-tone font-medium">
        {call && isITM('call') ? 'ITM' : ''}
      </td>

      {/* STRIKE */}
      <td className={classNames('px-3 py-1 text-center font-mono font-semibold', {
        'text-tone bg-amber-100 dark:bg-amber-900/30': isATM && !boxForStrike?.length,
        'text-ink': !isATM && !boxForStrike?.length,
        'bg-amber-200 dark:bg-amber-800/50 text-amber-900 dark:text-amber-200 outline outline-1 outline-amber-500': !!boxForStrike?.length,
      })}>
        {strike.toLocaleString()}
        {boxForStrike?.length ? (() => {
          const best = boxForStrike.reduce((a, b) => b.profit > a.profit ? b : a)
          const label = best.type === 'long' ? 'LB' : 'SB'
          const count = boxForStrike.length
          return (
            <span className="ml-1 text-[9px] bg-amber-500 text-white rounded px-0.5 font-bold whitespace-nowrap">
              {label} +${best.profit.toFixed(0)}{count > 1 ? ` ×${count}` : ''}
            </span>
          )
        })() : null}
      </td>

      {/* PUTS */}
      <td className="px-2 py-1 text-left text-xs text-tone font-medium">
        {put && isITM('put') ? 'ITM' : ''}
      </td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.vega) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.theta) : '--'}</td>
      <td className="px-2 py-1 text-left text-violet-600 dark:text-violet-400 text-[11px]">
        {fmtBE(put?.theta, put?.gamma)}
      </td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.delta) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.askVol  ? (put.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.markVol ? (put.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.bidVol  ? (put.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-2">
        {(() => { const r = fmt(put, 'buy'); return <><ExBadge ex={r.ex} /><span>{r.price}</span></> })()}
      </td>
      <td className="px-2 py-1 text-left text-ink-2">
        {(() => { const r = fmt(put, 'sell'); return <><ExBadge ex={r.ex} /><span>{r.price}</span></> })()}
      </td>
    </tr>
  )
}

const ALL_EXCHANGES: ExchangeKey[] = ['bybit', 'okx', 'deribit']
const EX_LABEL: Record<ExchangeKey, string> = EX_LABEL_MAP as Record<ExchangeKey, string>
const EX_COLOR: Record<ExchangeKey, string> = EX_BADGE as Record<ExchangeKey, string>

export default function CombinedOptionsChain({ data, spotPrice, expiration, lastUpdated, boxSpreads, activeExchanges: activeExchangesProp, onToggleExchange }: CombinedOptionsChainProps) {
  const [feesOn, setFeesOn] = useState(false)
  const [localExchanges, setLocalExchanges] = useState<Set<ExchangeKey>>(new Set(ALL_EXCHANGES))

  const activeExchanges = activeExchangesProp ?? localExchanges

  const toggleExchange = (ex: ExchangeKey) => {
    if (onToggleExchange) {
      onToggleExchange(ex)
    } else {
      setLocalExchanges(prev => {
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
  }

  if (!data || !data.calls || !data.puts) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">Loading combined options data…</p>
      </div>
    )
  }

  const allStrikes = new Set<number>()
  data.calls.forEach(c => allStrikes.add(c.strike))
  data.puts.forEach(p => allStrikes.add(p.strike))
  const sortedStrikes = Array.from(allStrikes).sort((a, b) => a - b)

  const callsMap = new Map<number, CombinedOptionContract>()
  const putsMap  = new Map<number, CombinedOptionContract>()
  data.calls.forEach(c => callsMap.set(c.strike, c))
  data.puts.forEach(p => putsMap.set(p.strike, p))

  const atmStrike = sortedStrikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  )

  const strikeToBox = new Map<number, BoxSpread[]>()
  for (const b of (boxSpreads ?? [])) {
    for (const k of [b.k1, b.k2]) {
      if (!strikeToBox.has(k)) strikeToBox.set(k, [])
      strikeToBox.get(k)!.push(b)
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Combined Options Chain</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {new Date(expiration).toLocaleDateString()} · Fwd{' '}
            <span className="font-mono text-ink">${spotPrice.toLocaleString()}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Exchange toggles */}
          <div className="flex items-center gap-1 text-[10px]">
            {ALL_EXCHANGES.map(ex => (
              <button
                key={ex}
                onClick={() => toggleExchange(ex)}
                className={classNames('px-1.5 py-0.5 rounded font-bold transition-opacity', EX_COLOR[ex], {
                  'text-white opacity-100': activeExchanges.has(ex),
                  'opacity-30': !activeExchanges.has(ex),
                })}
              >
                {EX_LABEL[ex]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setFeesOn(f => !f)}
            className={`px-2 py-1 rounded border text-xs font-medium transition-colors ${
              feesOn ? 'bg-amber-500 text-white border-amber-500' : 'text-ink-2 border-rim hover:bg-muted'
            }`}
          >
            Fees {feesOn ? 'On' : 'Off'}
          </button>
          {lastUpdated && (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs text-ink-3">{lastUpdated.toLocaleTimeString()}</span>
            </div>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-rim">
              <th colSpan={11} className="text-center py-1 text-green-700 dark:text-green-400 font-semibold bg-green-50 dark:bg-green-900/20 text-xs">CALLS</th>
              <th className="w-16" />
              <th colSpan={11} className="text-center py-1 text-red-600 dark:text-red-400 font-semibold bg-red-50 dark:bg-red-900/20 text-xs">PUTS</th>
            </tr>
            <tr className="border-b border-rim text-ink-2 text-xs">
              <th className="px-2 py-1 text-right font-medium">Best Bid</th>
              <th className="px-2 py-1 text-right font-medium">Best Ask</th>
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="px-2 py-1" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="px-2 py-1" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="px-2 py-1" />
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="px-2 py-1" />
              <GreekTh
                symbol="BE"
                name="Break-even Move"
                description="Min daily $ move for this option to break even: sqrt(2×|Θ|/Γ)"
                className="px-2 py-1"
              />
              <th className="px-1 py-1 text-right font-medium text-ink-3">bIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">aIV</th>
              <th className="px-2 py-1 text-right font-medium">ITM</th>
              <th className="px-3 py-1 text-center font-semibold text-ink">Strike</th>
              <th className="px-2 py-1 text-left font-medium">ITM</th>
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="px-2 py-1 text-left" />
              <GreekTh
                symbol="BE"
                name="Break-even Move"
                description="Min daily $ move for this option to break even: sqrt(2×|Θ|/Γ)"
                align="left"
                className="px-2 py-1 text-left"
              />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="px-2 py-1 text-left" />
              <th className="px-1 py-1 text-left font-medium text-ink-3">aIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">bIV</th>
              <th className="px-2 py-1 text-left font-medium">Best Ask</th>
              <th className="px-2 py-1 text-left font-medium">Best Bid</th>
            </tr>
          </thead>
          <tbody>
            {sortedStrikes.map(strike => (
              <CombinedRow
                key={strike}
                call={callsMap.get(strike)}
                put={putsMap.get(strike)}
                strike={strike}
                spotPrice={spotPrice}
                isATM={strike === atmStrike}
                feesOn={feesOn}
                activeExchanges={activeExchanges}
                boxForStrike={strikeToBox.get(strike)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 pt-3 border-t border-rim grid grid-cols-4 gap-4 text-xs">
        <div><div className="text-ink-3">Total Calls</div><div className="text-ink font-semibold">{data.calls.length}</div></div>
        <div><div className="text-ink-3">Total Puts</div><div className="text-ink font-semibold">{data.puts.length}</div></div>
        <div><div className="text-ink-3">ATM Strike</div><div className="text-ink font-semibold">{atmStrike.toLocaleString()}</div></div>
        <div><div className="text-ink-3">Strikes</div><div className="text-ink font-semibold">{sortedStrikes.length}</div></div>
      </div>
    </div>
  )
}
