'use client'

import { useState } from 'react'
import classNames from 'classnames'
import { CombinedOptionContract, CombinedOptionsChainData } from '@/types/options'
import GreekTh from '@/components/GreekTh'

const TAKER_FEE = 0.0003
const FEE_CAP: Record<string, number> = {
  bybit:   0.07,
  okx:     0.07,
  deribit: 0.125,
}

interface CombinedOptionsChainProps {
  data: CombinedOptionsChainData
  spotPrice: number
  expiration: string
  lastUpdated?: Date | null
}

interface CombinedRowProps {
  call?: CombinedOptionContract
  put?: CombinedOptionContract
  strike: number
  spotPrice: number
  isATM: boolean
  feesOn: boolean
}

function ExBadge({ ex }: { ex: 'bybit' | 'okx' | 'deribit' | null | undefined }) {
  if (!ex) return null
  return (
    <span className={classNames('ml-1 px-1 rounded text-white text-[9px] font-bold', {
      'bg-orange-500': ex === 'bybit',
      'bg-zinc-700':   ex === 'okx',
      'bg-blue-600':   ex === 'deribit',
    })}>
      {ex === 'bybit' ? 'BYB' : ex === 'okx' ? 'OKX' : 'DER'}
    </span>
  )
}

function CombinedRow({ call, put, strike, spotPrice, isATM, feesOn }: CombinedRowProps) {
  const withFee = (price: number | undefined | null, side: 'buy' | 'sell', ex: string | null | undefined) => {
    if (!price || !feesOn) return price ?? 0
    const cap = FEE_CAP[ex ?? ''] ?? 0.07
    const fee = Math.min(TAKER_FEE * spotPrice, cap * price)
    return side === 'buy' ? price + fee : price - fee
  }

  const fmt = (v: number | undefined | null, side: 'buy' | 'sell', ex: string | null | undefined) => {
    const adjusted = withFee(v, side, ex)
    return !adjusted ? '--' : adjusted.toFixed(2)
  }
  const fmtG = (v: number | undefined | null, dp = 2) => !v ? '--' : v.toFixed(dp)

  const isITM = (type: 'call' | 'put') =>
    type === 'call' ? strike < spotPrice : strike > spotPrice

  return (
    <tr className={classNames('border-b hover:bg-muted text-xs', {
      'bg-amber-50 dark:bg-amber-950/30': isATM,
      'border-rim': true,
    })}>
      {/* CALLS */}
      <td className="px-2 py-1 text-right text-ink-2">
        {call ? <><span>{fmt(call.bestBid, 'sell', call.bestBidEx)}</span><ExBadge ex={call.bestBidEx} /></> : '--'}
      </td>
      <td className="px-2 py-1 text-right text-ink-2">
        {call ? <><span>{fmt(call.bestAsk, 'buy', call.bestAskEx)}</span><ExBadge ex={call.bestAskEx} /></> : '--'}
      </td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.delta) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.theta) : '--'}</td>
      <td className="px-2 py-1 text-right text-ink-3">{call ? fmtG(call.vega) : '--'}</td>
      <td className="px-2 py-1 text-right text-xs text-tone font-medium">
        {call && isITM('call') ? 'ITM' : ''}
      </td>

      {/* STRIKE */}
      <td className={classNames('px-3 py-1 text-center font-mono font-semibold', {
        'text-tone bg-amber-100 dark:bg-amber-900/30': isATM,
        'text-ink': !isATM,
      })}>
        {strike.toLocaleString()}
      </td>

      {/* PUTS */}
      <td className="px-2 py-1 text-left text-xs text-tone font-medium">
        {put && isITM('put') ? 'ITM' : ''}
      </td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.vega) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.theta) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.gamma, 5) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-3">{put ? fmtG(put.delta) : '--'}</td>
      <td className="px-2 py-1 text-left text-ink-2">
        {put ? <><span>{fmt(put.bestAsk, 'buy', put.bestAskEx)}</span><ExBadge ex={put.bestAskEx} /></> : '--'}
      </td>
      <td className="px-2 py-1 text-left text-ink-2">
        {put ? <><span>{fmt(put.bestBid, 'sell', put.bestBidEx)}</span><ExBadge ex={put.bestBidEx} /></> : '--'}
      </td>
    </tr>
  )
}

export default function CombinedOptionsChain({ data, spotPrice, expiration, lastUpdated }: CombinedOptionsChainProps) {
  const [feesOn, setFeesOn] = useState(false)

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

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Combined Options Chain</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {new Date(expiration).toLocaleDateString()} · Spot{' '}
            <span className="font-mono text-ink">${spotPrice.toLocaleString()}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Exchange legend */}
          <div className="flex items-center gap-2 text-[10px] text-ink-3">
            <span className="px-1.5 py-0.5 rounded bg-orange-500 text-white font-bold">BYB</span>
            <span className="px-1.5 py-0.5 rounded bg-zinc-700 text-white font-bold">OKX</span>
            <span className="px-1.5 py-0.5 rounded bg-blue-600 text-white font-bold">DER</span>
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
              <th colSpan={7} className="text-center py-1 text-green-700 dark:text-green-400 font-semibold bg-green-50 dark:bg-green-900/20 text-xs">CALLS</th>
              <th className="w-16" />
              <th colSpan={7} className="text-center py-1 text-red-600 dark:text-red-400 font-semibold bg-red-50 dark:bg-red-900/20 text-xs">PUTS</th>
            </tr>
            <tr className="border-b border-rim text-ink-2 text-xs">
              <th className="px-2 py-1 text-right font-medium">Best Bid</th>
              <th className="px-2 py-1 text-right font-medium">Best Ask</th>
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="px-2 py-1" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="px-2 py-1" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="px-2 py-1" />
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="px-2 py-1" />
              <th className="px-2 py-1 text-right font-medium">ITM</th>
              <th className="px-3 py-1 text-center font-semibold text-ink">Strike</th>
              <th className="px-2 py-1 text-left font-medium">ITM</th>
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="px-2 py-1 text-left" />
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="px-2 py-1 text-left" />
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
