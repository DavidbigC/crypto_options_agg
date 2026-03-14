'use client'

import { useEffect, useRef, useState } from 'react'
import classNames from 'classnames'
import { CombinedOptionContract, CombinedOptionsChainData } from '@/types/options'
import { BoxSpread } from '@/lib/strategies'

import GreekTh from '@/components/GreekTh'
import { EX_BADGE, EX_LABEL as EX_LABEL_MAP } from '@/lib/exchangeColors'
import { collectSortedStrikes, findAtmStrike, getOptionMoneyness } from '@/lib/optionsChainLayout.js'

const COL_WIDTHS = [
  '4.5rem', '4.75rem', '5rem', '4.5rem', '4.25rem', '4.25rem', '4.25rem', '5rem', '7.5rem', '7.5rem',
  '6rem',
  '7.5rem', '7.5rem', '5rem', '4.25rem', '4.25rem', '4.25rem', '4.5rem', '5rem', '4.75rem', '4.5rem',
]

const TAKER_FEE = 0.0003
const FEE_CAP: Record<string, number> = {
  bybit:   0.07,
  okx:     0.07,
  deribit: 0.125,
  derive:  0.07,
  binance: 0.1,
}

type ExchangeKey = 'bybit' | 'okx' | 'deribit' | 'derive' | 'binance'

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
  daysToExpiry: number
  atmStrike: number | null
}

function ExBadge({ ex }: { ex: 'bybit' | 'okx' | 'deribit' | 'derive' | 'binance' | null | undefined }) {
  return (
    <span className={classNames('inline-block ml-1 w-[26px] text-center rounded text-[9px] font-bold', ex ? EX_BADGE[ex] : 'invisible')}>
      {ex ? EX_LABEL_MAP[ex] : ''}
    </span>
  )
}

function MoneynessLegend() {
  return (
    <div className="flex items-center gap-4 text-[11px] text-ink-3">
      <span className="text-ink-2">Left = Call</span>
      <span className="text-ink-2">Right = Put</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm border border-emerald-500/80 dark:border-emerald-400/80" />
        ITM
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm border border-stone-400/80 dark:border-stone-500/80 bg-stone-100/70 dark:bg-stone-900/40" />
        ATM
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm border border-rose-500/80 dark:border-rose-400/80" />
        OTM
      </span>
    </div>
  )
}

function CombinedRow({ call, put, strike, spotPrice, isATM, feesOn, activeExchanges, boxForStrike, daysToExpiry, atmStrike }: CombinedRowProps) {
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
    for (const ex of Array.from(activeExchanges)) {
      const raw = side === 'sell' ? prices[ex as keyof typeof prices]?.bid : prices[ex as keyof typeof prices]?.ask
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

  const sellAPR = (contract: CombinedOptionContract | undefined, collateral: number): string => {
    if (!contract || daysToExpiry <= 0 || collateral <= 0) return '--'
    const { val, ex } = bestFiltered(contract, 'sell')
    if (!val || !ex) return '--'
    const net = withFee(val, 'sell', ex)
    if (net <= 0) return '--'
    return ((net / collateral) * (365 / daysToExpiry) * 100).toFixed(1) + '%'
  }

  const callMoneyness = getOptionMoneyness({ optionType: 'call', strike, spotPrice, atmStrike })
  const putMoneyness = getOptionMoneyness({ optionType: 'put', strike, spotPrice, atmStrike })

  const strikeEdgeClass = (moneyness: 'itm' | 'atm' | 'otm') => classNames(
    'absolute top-1 bottom-1 w-[2px] rounded-full',
    {
      'bg-emerald-500/85 dark:bg-emerald-400/85': moneyness === 'itm',
      'bg-stone-400/85 dark:bg-stone-500/85': moneyness === 'atm',
      'bg-rose-500/85 dark:bg-rose-400/85': moneyness === 'otm',
    },
  )

  return (
    <tr className={classNames('border-b hover:bg-muted text-xs', {
      'border-rim': true,
    })}>
      {/* CALLS */}
      <td className="px-2 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtG(call.vega) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtG(call.theta) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtG(call.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtG(call.delta) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.askVol  ? (call.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.markVol ? (call.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.bidVol  ? (call.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1.5 py-1 text-right text-amber-600 dark:text-amber-400 text-[11px] font-mono whitespace-nowrap">
        {sellAPR(call, spotPrice)}
      </td>
      <td className="px-2 py-1 text-right text-ink-2 whitespace-nowrap">
        {(() => { const r = fmt(call, 'buy'); return <><span>{r.price}</span><ExBadge ex={r.ex} /></> })()}
      </td>
      <td className="px-2 py-1 text-right text-ink-2 whitespace-nowrap">
        {(() => { const r = fmt(call, 'sell'); return <><span>{r.price}</span><ExBadge ex={r.ex} /></> })()}
      </td>

      {/* STRIKE */}
      <td className={classNames('relative px-3 py-1 text-center font-mono font-semibold whitespace-nowrap', {
        'text-tone bg-amber-100 dark:bg-amber-900/30': callMoneyness === 'atm' && putMoneyness === 'atm' && !boxForStrike?.length,
        'text-ink': !(callMoneyness === 'atm' && putMoneyness === 'atm') && !boxForStrike?.length,
        'bg-amber-200 dark:bg-amber-800/50 text-amber-900 dark:text-amber-200 outline-amber-500 group/strike cursor-help': !!boxForStrike?.length,
      })}>
        {!boxForStrike?.length ? <span className={classNames(strikeEdgeClass(callMoneyness), 'left-0')} /> : null}
        {!boxForStrike?.length ? <span className={classNames(strikeEdgeClass(putMoneyness), 'right-0')} /> : null}
        {strike.toLocaleString()}
        {boxForStrike?.length ? (() => {
          const best = boxForStrike.reduce((a, b) => b.profit > a.profit ? b : a)
          const label = best.type === 'long' ? 'LB' : 'SB'
          const count = boxForStrike.length
          return (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/strike:block z-50 pointer-events-none">
              <div className="bg-card border border-rim rounded px-2 py-1 text-[10px] shadow-xl whitespace-nowrap text-ink font-sans font-normal">
                <span className="font-bold text-amber-600">{label}</span>
                {' '}+${best.profit.toFixed(0)}{count > 1 ? ` ×${count}` : ''}
              </div>
            </div>
          )
        })() : null}
      </td>

      {/* PUTS */}
      <td className="px-2 py-1 text-left text-ink-2 whitespace-nowrap">
        {(() => { const r = fmt(put, 'sell'); return <><ExBadge ex={r.ex} /><span>{r.price}</span></> })()}
      </td>
      <td className="px-2 py-1 text-left text-ink-2 whitespace-nowrap">
        {(() => { const r = fmt(put, 'buy'); return <><ExBadge ex={r.ex} /><span>{r.price}</span></> })()}
      </td>
      <td className="px-1.5 py-1 text-left text-amber-600 dark:text-amber-400 text-[11px] font-mono whitespace-nowrap">
        {sellAPR(put, strike)}
      </td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.bidVol  ? (put.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.markVol ? (put.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.askVol  ? (put.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtG(put.delta) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtG(put.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtG(put.theta) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtG(put.vega) : '--'}</td>
    </tr>
  )
}

const ALL_EXCHANGES: ExchangeKey[] = ['bybit', 'okx', 'deribit', 'derive', 'binance']
const EX_LABEL: Record<ExchangeKey, string> = EX_LABEL_MAP as Record<ExchangeKey, string>
const EX_COLOR: Record<ExchangeKey, string> = EX_BADGE as Record<ExchangeKey, string>

export default function CombinedOptionsChain({ data, spotPrice, expiration, lastUpdated, boxSpreads, activeExchanges: activeExchangesProp, onToggleExchange }: CombinedOptionsChainProps) {
  const [feesOn, setFeesOn] = useState(false)
  const [localExchanges, setLocalExchanges] = useState<Set<ExchangeKey>>(new Set(ALL_EXCHANGES))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const strikeHeaderRef = useRef<HTMLTableCellElement | null>(null)
  const hasChainData = Boolean(data && data.calls && data.puts)
  const sortedStrikes = hasChainData ? collectSortedStrikes(data) : []
  const atmStrike = findAtmStrike(sortedStrikes, spotPrice)

  const activeExchanges = activeExchangesProp ?? localExchanges

  useEffect(() => {
    if (!hasChainData || sortedStrikes.length === 0) return

    const scrollEl = scrollRef.current
    const strikeEl = strikeHeaderRef.current
    if (!scrollEl || !strikeEl) return

    const strikeCenter = strikeEl.offsetLeft + strikeEl.offsetWidth / 2
    const target = strikeCenter - scrollEl.clientWidth / 2
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth)
    scrollEl.scrollLeft = Math.min(Math.max(target, 0), maxScroll)
  }, [expiration, hasChainData, spotPrice, sortedStrikes.length, activeExchanges.size])

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

  if (!hasChainData) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">Loading combined options data…</p>
      </div>
    )
  }

  if (sortedStrikes.length === 0) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">No combined options data for this expiry yet.</p>
      </div>
    )
  }

  const callsMap = new Map<number, CombinedOptionContract>()
  const putsMap  = new Map<number, CombinedOptionContract>()
  data.calls.forEach(c => callsMap.set(c.strike, c))
  data.puts.forEach(p => putsMap.set(p.strike, p))

  const strikeToBox = new Map<number, BoxSpread[]>()
  for (const b of (boxSpreads ?? [])) {
    for (const k of [b.k1, b.k2]) {
      if (!strikeToBox.has(k)) strikeToBox.set(k, [])
      strikeToBox.get(k)!.push(b)
    }
  }

  const daysToExpiry = Math.max(0, (new Date(expiration + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

  return (
    <div className="surface-band px-5 py-5">
      <div className="flex items-center justify-between mb-4 gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Cross-venue synthesis</div>
          <h2 className="heading-serif mt-1 text-2xl font-semibold text-ink">Combined options chain</h2>
          <p className="mt-1 text-sm text-ink-2">
            {new Date(expiration).toLocaleDateString()} · Forward{' '}
            <span className="font-mono text-ink">${spotPrice.toLocaleString()}</span>
          </p>
          <div className="mt-2">
            <MoneynessLegend />
          </div>
        </div>

        <div className="surface-well flex items-center gap-3 px-2 py-2">
          {/* Exchange toggles */}
          <div className="flex items-center gap-1 text-[10px]">
            {ALL_EXCHANGES.map(ex => (
              <button
                key={ex}
                onClick={() => toggleExchange(ex)}
                className={classNames('rounded-full px-2 py-1 font-bold transition-opacity', EX_COLOR[ex], {
                  'text-white opacity-100': activeExchanges.has(ex),
                  'opacity-45': !activeExchanges.has(ex),
                })}
              >
                {EX_LABEL[ex]}
              </button>
            ))}
          </div>
          <button
            onClick={() => setFeesOn(f => !f)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              feesOn ? 'bg-card text-ink border-rim shadow-sm ring-1 ring-rim' : 'text-ink-2 border-rim hover:bg-card/75'
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

      <div ref={scrollRef} className="overflow-x-auto">
        <table className="min-w-full w-max table-fixed text-xs tabular-nums">
          <colgroup>
            {COL_WIDTHS.map((width, index) => (
              <col key={index} style={{ width }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-rim">
              <th colSpan={10} className="bg-muted/70 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-2">Calls</th>
              <th className="w-16" />
              <th colSpan={10} className="bg-muted/70 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-2">Puts</th>
            </tr>
            <tr className="border-b border-rim text-ink-2 text-xs">
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="px-2 py-1" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="px-2 py-1" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="px-2 py-1" />
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="px-2 py-1" />
              <th className="px-1 py-1 text-right font-medium text-ink-3">aIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">bIV</th>
              <th className="px-1.5 py-1 text-right font-medium text-amber-600 dark:text-amber-400">APR</th>
              <th className="px-2 py-1 text-right font-medium">Best Ask</th>
              <th className="px-2 py-1 text-right font-medium">Best Bid</th>
              <th ref={strikeHeaderRef} className="px-3 py-1 text-center font-semibold text-ink">Strike</th>
              <th className="px-2 py-1 text-left font-medium">Best Bid</th>
              <th className="px-2 py-1 text-left font-medium">Best Ask</th>
              <th className="px-1.5 py-1 text-left font-medium text-amber-600 dark:text-amber-400">APR</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">bIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">aIV</th>
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="px-2 py-1 text-left" />
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
                daysToExpiry={daysToExpiry}
                atmStrike={atmStrike}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid gap-3 border-t border-rim pt-4 text-xs sm:grid-cols-4">
        <div className="surface-well px-3 py-2"><div className="text-ink-3">Total Calls</div><div className="mt-1 font-semibold text-ink">{data.calls.length}</div></div>
        <div className="surface-well px-3 py-2"><div className="text-ink-3">Total Puts</div><div className="mt-1 font-semibold text-ink">{data.puts.length}</div></div>
        <div className="surface-well px-3 py-2"><div className="text-ink-3">ATM Strike</div><div className="mt-1 font-semibold text-ink">{atmStrike?.toLocaleString() ?? '--'}</div></div>
        <div className="surface-well px-3 py-2"><div className="text-ink-3">Strikes</div><div className="mt-1 font-semibold text-ink">{sortedStrikes.length}</div></div>
      </div>
    </div>
  )
}
