'use client'

import { useEffect, useRef, useState } from 'react'
import classNames from 'classnames'
import { OptionsChainData, OptionContract, Exchange } from '@/types/options'
import GreekTh from '@/components/GreekTh'
import { collectSortedStrikes, findAtmStrike, getOptionMoneyness } from '@/lib/optionsChainLayout.js'

const COL_WIDTHS = [
  '4.5rem', '4.75rem', '5rem', '4.5rem', '4.25rem', '4.25rem', '4.25rem', '5rem', '6.5rem', '6.5rem',
  '6rem',
  '6.5rem', '6.5rem', '5rem', '4.25rem', '4.25rem', '4.25rem', '4.5rem', '5rem', '4.75rem', '4.5rem',
]

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
  atmStrike: number | null
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

function OptionRow({ call, put, strike, spotPrice, isATM, exchange, priceUnit, feesOn, daysToExpiry, atmStrike }: OptionRowProps) {
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
      <td className="px-1 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtGreek(call.vega, 'vega', 1) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtGreek(call.theta, 'theta', 1) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtGreek(call.gamma, 'gamma', 5) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 whitespace-nowrap">{call ? fmtGreek(call.delta, 'delta', 2) : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.askVol  ? (call.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.markVol ? (call.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-3 text-[11px] whitespace-nowrap">{call?.bidVol  ? (call.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-right text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
        {call ? sellAPR(call.bid, spotPrice) : '--'}
      </td>
      <td className="px-1 py-1 text-right text-ink-2 whitespace-nowrap">{call ? formatPrice(call.ask, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-right text-ink-2 whitespace-nowrap">{call ? formatPrice(call.bid, 'sell') : '--'}</td>

      {/* STRIKE */}
      <td className={classNames('relative px-2 py-1 text-center font-mono font-semibold whitespace-nowrap', {
        'text-tone bg-amber-100 dark:bg-amber-900/30': callMoneyness === 'atm' && putMoneyness === 'atm',
        'text-ink': !(callMoneyness === 'atm' && putMoneyness === 'atm'),
      })}>
        <span className={classNames(strikeEdgeClass(callMoneyness), 'left-0')} />
        <span className={classNames(strikeEdgeClass(putMoneyness), 'right-0')} />
        {strike.toLocaleString()}
      </td>

      {/* PUTS */}
      <td className="px-1 py-1 text-left text-ink-2 whitespace-nowrap">{put ? formatPrice(put.bid, 'sell') : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-2 whitespace-nowrap">{put ? formatPrice(put.ask, 'buy') : '--'}</td>
      <td className="px-1 py-1 text-left text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
        {put ? sellAPR(put.bid, strike) : '--'}
      </td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.bidVol  ? (put.bidVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.markVol ? (put.markVol * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 text-[11px] whitespace-nowrap">{put?.askVol  ? (put.askVol  * 100).toFixed(1) + '%' : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtGreek(put.delta, 'delta', 2) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtGreek(put.gamma, 'gamma', 5) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtGreek(put.theta, 'theta', 1) : '--'}</td>
      <td className="px-1 py-1 text-left text-ink-3 whitespace-nowrap">{put ? fmtGreek(put.vega, 'vega', 1) : '--'}</td>
    </tr>
  )
}

export default function OptionsChain({ data, spotPrice, expiration, lastUpdated, exchange = 'bybit' }: OptionsChainProps) {
  const [priceUnit, setPriceUnit] = useState<'usd' | 'btc'>('usd')
  const [feesOn, setFeesOn] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const strikeHeaderRef = useRef<HTMLTableCellElement | null>(null)
  const hasChainData = Boolean(data && data.calls && data.puts)
  const sortedStrikes = hasChainData ? collectSortedStrikes(data) : []
  const atmStrike = findAtmStrike(sortedStrikes, spotPrice)

  useEffect(() => {
    if (!hasChainData || sortedStrikes.length === 0) return

    const scrollEl = scrollRef.current
    const strikeEl = strikeHeaderRef.current
    if (!scrollEl || !strikeEl) return

    const strikeCenter = strikeEl.offsetLeft + strikeEl.offsetWidth / 2
    const target = strikeCenter - scrollEl.clientWidth / 2
    const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth)
    scrollEl.scrollLeft = Math.min(Math.max(target, 0), maxScroll)
  }, [expiration, hasChainData, spotPrice, sortedStrikes.length])

  if (!hasChainData) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">Loading options data…</p>
      </div>
    )
  }

  if (sortedStrikes.length === 0) {
    return (
      <div className="card flex items-center justify-center h-64">
        <p className="text-ink-2">No options data for this expiry yet.</p>
      </div>
    )
  }

  const callsMap = new Map<number, OptionContract>()
  const putsMap  = new Map<number, OptionContract>()
  data.calls.forEach(c => callsMap.set(c.strike, c))
  data.puts.forEach(p => putsMap.set(p.strike, p))

  // Bybit options expire at 08:00 UTC
  const daysToExpiry = Math.max(0.01, (new Date(expiration + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

  return (
    <div className="surface-band px-5 py-5">
      <div className="flex items-center justify-between mb-4 gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Primary surface</div>
          <h2 className="heading-serif mt-1 text-2xl font-semibold text-ink">Options chain</h2>
          <p className="mt-1 text-sm text-ink-2">
            {new Date(expiration).toLocaleDateString()} · Forward{' '}
            <span className="font-mono text-ink">${spotPrice.toLocaleString()}</span>
          </p>
          <div className="mt-2">
            <MoneynessLegend />
          </div>
        </div>

        <div className="surface-well flex items-center gap-2 px-2 py-2">
          {exchange === 'okx' && (
            <div className="flex overflow-hidden rounded-full border border-rim text-xs">
              <button
                className={`px-3 py-1.5 ${priceUnit === 'usd' ? 'bg-card text-ink shadow-sm' : 'text-ink-2 hover:bg-card/75'}`}
                onClick={() => setPriceUnit('usd')}
              >USD</button>
              <button
                className={`px-3 py-1.5 ${priceUnit === 'btc' ? 'bg-card text-ink shadow-sm' : 'text-ink-2 hover:bg-card/75'}`}
                onClick={() => setPriceUnit('btc')}
              >BTC</button>
            </div>
          )}
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
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" className="px-1 py-1 text-right" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" className="px-1 py-1 text-right" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" className="px-1 py-1 text-right" />
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" className="px-1 py-1 text-right" />
              <th className="px-1 py-1 text-right font-medium text-ink-3">aIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-right font-medium text-ink-3">bIV</th>
              <GreekTh symbol="APR" name="Sell Call APR" description="Annualised yield from selling this call (dual investment — you sell BTC at strike if price rises above it)" className="px-1 py-1 text-right text-amber-600 dark:text-amber-400" align="left" />
              <th className="px-1 py-1 text-right font-medium">Ask</th>
              <th className="px-1 py-1 text-right font-medium">Bid</th>
              <th ref={strikeHeaderRef} className="px-2 py-1 text-center font-semibold text-ink">Strike</th>
              <th className="px-1 py-1 text-left font-medium">Bid</th>
              <th className="px-1 py-1 text-left font-medium">Ask</th>
              <GreekTh symbol="APR" name="Sell Put APR" description="Annualised yield from selling this put (dual investment — you buy BTC at strike if price falls below it)" className="px-1 py-1 text-left text-amber-600 dark:text-amber-400" align="right" />
              <th className="px-1 py-1 text-left font-medium text-ink-3">bIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">mIV</th>
              <th className="px-1 py-1 text-left font-medium text-ink-3">aIV</th>
              <GreekTh symbol="Δ" name="Delta" description="price change per $1 move in underlying" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="Γ" name="Gamma" description="rate of change of delta per $1 move" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="Θ" name="Theta" description="daily time decay in USD" align="left" className="px-1 py-1 text-left" />
              <GreekTh symbol="V" name="Vega" description="price change per 1% move in implied vol" align="left" className="px-1 py-1 text-left" />
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
