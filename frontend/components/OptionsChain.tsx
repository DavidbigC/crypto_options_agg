'use client'

import { useState } from 'react'
import classNames from 'classnames'
import { OptionsChainData, OptionContract, Exchange } from '@/types/options'
import GreekTh from '@/components/GreekTh'


interface OptionsChainProps {
  data: OptionsChainData
  spotPrice: number
  expiration: string
  lastUpdated?: Date | null
  exchange?: Exchange
}

const TAKER_FEE = 0.0003
const FEE_CAP: Record<string, number> = {
  bybit:   0.07,
  okx:     0.07,
  deribit: 0.125,
}

interface OptionRowProps {
  call?: OptionContract
  put?: OptionContract
  strike: number
  spotPrice: number
  isATM: boolean
  exchange: Exchange
  priceUnit: 'usd' | 'btc'
  feesOn: boolean
  daysToExpiry: number
}

function OptionRow({ call, put, strike, spotPrice, isATM, exchange, priceUnit, feesOn, daysToExpiry }: OptionRowProps) {
  const formatValue = (value: number, decimals = 2) => value === 0 ? '--' : value.toFixed(decimals)

  const withFee = (price: number, side: 'buy' | 'sell') => {
    if (!feesOn || price === 0) return price
    const spot = exchange === 'okx' && priceUnit === 'btc' ? 1 : spotPrice
    const cap = FEE_CAP[exchange] ?? 0.07
    const fee = Math.min(TAKER_FEE * spot, cap * price)
    return side === 'buy' ? price + fee : price - fee
  }

  const sellAPR = (bid: number, collateral: number) => {
    if (bid <= 0 || collateral <= 0 || daysToExpiry <= 0) return '--'
    const bidUsd = exchange === 'okx' && spotPrice > 0 ? bid * spotPrice : bid
    const net = withFee(bidUsd, 'sell')
    if (net <= 0) return '--'
    return ((net / collateral) * (365 / daysToExpiry) * 100).toFixed(1) + '%'
  }

  const formatPrice = (value: number, side: 'buy' | 'sell') => {
    const adjusted = withFee(value, side)
    if (adjusted === 0) return '--'
    if (exchange === 'okx') {
      if (priceUnit === 'usd' && spotPrice > 0) return (adjusted * spotPrice).toFixed(2)
      return adjusted.toFixed(4)
    }
    return adjusted.toFixed(2)
  }

  const fmtGreek = (value: number, type: 'delta' | 'gamma' | 'theta' | 'vega', decimals: number) => {
    if (value === 0) return '--'
    if (exchange === 'okx' && priceUnit === 'btc' && spotPrice > 0) {
      if (type === 'theta' || type === 'vega') value = value / spotPrice
      else if (type === 'gamma') value = value * spotPrice
    }
    return value.toFixed(decimals)
  }

  const isITM = (optionType: 'call' | 'put', strike: number, spot: number) =>
    optionType === 'call' ? strike < spot : strike > spot

  return (
    <tr className={classNames('border-b hover:bg-muted text-xs', {
      'bg-amber-50 dark:bg-amber-950/30': isATM,
      'border-rim': true,
    })}>
      {/* CALLS */}
      <td className="px-1 py-1 text-right text-ink-2">{call ? formatPrice(call.bid, 'sell') : '--'}</td>
      <td className={classNames('px-1 py-1 text-right text-xs font-medium text-amber-600 dark:text-amber-400', {
        'opacity-30': call && isITM('call', strike, spotPrice),
      })}>
        {call ? sellAPR(call.bid, spotPrice) : '--'}
      </td>
      <td className="px-1 py-1 text-right text-ink-2">{call ? formatPrice(call.ask, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3">{call ? formatPrice(call.last, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.bidVol  ? (call.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.markVol ? (call.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px]">{call?.askVol  ? (call.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3">{call ? fmtGreek(call.delta, 'delta', 2) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3">{call ? fmtGreek(call.gamma, 'gamma', 5) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3">{call ? fmtGreek(call.theta, 'theta', 1) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3">{call ? fmtGreek(call.vega, 'vega', 1) : '--'}</td>
      <td className="px-1 py-1 text-right text-xs text-tone font-medium">
        {call && isITM('call', strike, spotPrice) ? 'ITM' : ''}
      </td>

      {/* STRIKE */}
      <td className={classNames('px-2 py-1 text-center font-mono font-semibold', {
        'text-tone bg-amber-100 dark:bg-amber-900/30': isATM,
        'text-ink': !isATM,
      })}>
        {strike.toLocaleString()}
      </td>

      {/* PUTS */}
      <td className="px-1 py-1 text-left text-xs text-tone font-medium">
        {put && isITM('put', strike, spotPrice) ? 'ITM' : ''}
      </td>
      <td className="px-1 py-1 text-left text-ink-3">{put ? fmtGreek(put.vega, 'vega', 1) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3">{put ? fmtGreek(put.theta, 'theta', 1) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3">{put ? fmtGreek(put.gamma, 'gamma', 5) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3">{put ? fmtGreek(put.delta, 'delta', 2) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.askVol  ? (put.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.markVol ? (put.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px]">{put?.bidVol  ? (put.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3">{put ? formatPrice(put.last, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-2">{put ? formatPrice(put.ask, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-2">{put ? formatPrice(put.bid, 'sell') : '--'}</td>
      <td className={classNames('px-1 py-1 text-left text-xs font-medium text-amber-600 dark:text-amber-400', {
        'opacity-30': put && isITM('put', strike, spotPrice),
      })}>
        {put ? sellAPR(put.bid, strike) : '--'}
      </td>
    </tr>
  )
}

export default function OptionsChain({ data, spotPrice, expiration, lastUpdated, exchange = 'bybit' }: OptionsChainProps) {
  const [priceUnit, setPriceUnit] = useState<'usd' | 'btc'>('usd')
  const [feesOn, setFeesOn] = useState(false)

  if (!data || !data.calls || !data.puts) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">Loading options data…</p>
      </div>
    )
  }

  const allStrikes = new Set<number>()
  data.calls.forEach(c => allStrikes.add(c.strike))
  data.puts.forEach(p => allStrikes.add(p.strike))
  const sortedStrikes = Array.from(allStrikes).sort((a, b) => a - b)

  const callsMap = new Map<number, OptionContract>()
  const putsMap  = new Map<number, OptionContract>()
  data.calls.forEach(c => callsMap.set(c.strike, c))
  data.puts.forEach(p => putsMap.set(p.strike, p))

  const atmStrike = sortedStrikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  )

  // Bybit options expire at 08:00 UTC
  const daysToExpiry = Math.max(0.01, (new Date(expiration + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">Options Chain</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {new Date(expiration).toLocaleDateString()} · Fwd{' '}
            <span className="font-mono text-ink">${spotPrice.toLocaleString()}</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {exchange === 'okx' && (
            <div className="flex rounded-md overflow-hidden border border-rim text-xs">
              <button
                className={`px-2 py-1 ${priceUnit === 'usd' ? 'bg-tone text-white' : 'text-ink-2 hover:bg-muted'}`}
                onClick={() => setPriceUnit('usd')}
              >USD</button>
              <button
                className={`px-2 py-1 ${priceUnit === 'btc' ? 'bg-tone text-white' : 'text-ink-2 hover:bg-muted'}`}
                onClick={() => setPriceUnit('btc')}
              >BTC</button>
            </div>
          )}
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
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b border-rim">
              <th colSpan={12} className="text-center py-1 text-green-700 dark:text-green-400 font-semibold bg-green-50 dark:bg-green-900/20 text-xs">CALLS</th>
              <th className="w-16" />
              <th colSpan={12} className="text-center py-1 text-red-600 dark:text-red-400 font-semibold bg-red-50 dark:bg-red-900/20 text-xs">PUTS</th>
            </tr>
            <tr className="border-b border-rim text-ink-2 text-xs">
              <th className="px-1 py-1 text-right font-medium">Bid</th>
              <GreekTh symbol="APR" name="Sell Call APR" description="Annualised yield from selling this call (dual investment — you sell BTC at strike if price rises above it)" className="px-1 py-1 text-right text-amber-600 dark:text-amber-400" align="left" />
              <th className="px-1 py-1 text-right font-medium">Ask</th>
              <th className="px-1 py-1 text-right font-medium">Last</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">bIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">aIV</th>
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="px-1 py-1 text-right" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="px-1 py-1 text-right" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="px-1 py-1 text-right" />
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="px-1 py-1 text-right" />
              <th className="px-1 py-1 text-right font-medium">ITM</th>
              <th className="px-2 py-1 text-center font-semibold text-ink">Strike</th>
              <th className="px-1 py-1 text-left font-medium">ITM</th>
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="px-1 py-1 text-left" />
              <th className="px-1 py-1 text-left font-medium text-ink-3">aIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">bIV</th>
              <th className="px-1 py-1 text-left font-medium">Last</th>
              <th className="px-1 py-1 text-left font-medium">Ask</th>
              <th className="px-1 py-1 text-left font-medium">Bid</th>
              <GreekTh symbol="APR" name="Sell Put APR" description="Annualised yield from selling this put (dual investment — you buy BTC at strike if price falls below it)" className="px-1 py-1 text-left text-amber-600 dark:text-amber-400" align="right" />
            </tr>
          </thead>
          <tbody>
            {sortedStrikes.map(strike => (
              <OptionRow
                key={strike}
                call={callsMap.get(strike)}
                put={putsMap.get(strike)}
                strike={strike}
                spotPrice={spotPrice}
                isATM={strike === atmStrike}
                exchange={exchange}
                priceUnit={priceUnit}
                feesOn={feesOn}
                daysToExpiry={daysToExpiry}
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
