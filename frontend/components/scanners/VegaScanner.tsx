'use client'

import { useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'

interface VegaScannerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
  activeExchanges?: Set<string>
}

interface VegaRow {
  expiry: string
  dte: number
  type: 'straddle' | 'strangle'
  callStrike: number
  putStrike: number
  askCost: number
  bidCost: number
  vega: number
  theta: number
  markIV: number
  vegaPerDollar: number
  beIVMove: number
}

interface StrategyRow {
  expiry: string
  dte: number
  type: 'straddle' | 'strangle'
  callStrike: number
  putStrike: number
  cost: number
  vega: number
  theta: number
  markIV: number         // average mark IV of the two legs
  vegaPerDollar: number  // vega / cost — higher is better for longs
  beIVMove: number       // cost / vega — vol points needed to break even
  thetaToEvent: number | null
}

function getBestAsk(contract: any, activeExchanges?: Set<string>): number {
  if (activeExchanges && contract.prices) {
    let best = 0
    for (const ex of Array.from(activeExchanges)) {
      const ask = contract.prices[ex]?.ask
      if (ask && ask > 0 && (best === 0 || ask < best)) best = ask
    }
    if (best > 0) return best
  }
  return (contract.bestAsk ?? contract.ask) || 0
}

function getBestBid(contract: any, activeExchanges?: Set<string>): number {
  if (activeExchanges && contract.prices) {
    let best = 0
    for (const ex of Array.from(activeExchanges)) {
      const bid = contract.prices[ex]?.bid
      if (bid && bid > 0 && (best === 0 || bid > best)) best = bid
    }
    if (best > 0) return best
  }
  return (contract.bestBid ?? contract.bid) || 0
}

export default function VegaScanner({ optionsData, spotPrice, coin, exchange, activeExchanges }: VegaScannerProps) {
  const [eventDate, setEventDate] = useState('')
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [rawRows, setRawRows] = useState<VegaRow[]>([])

  useEffect(() => {
    setRawRows([])
    let cancelled = false
    const fetchRows = () => {
      fetch(`/api/scanners/${exchange}/${coin}`)
        .then(r => r.json())
        .then(data => {
          if (!cancelled) setRawRows(data.vega ?? [])
        })
        .catch(() => {})
    }
    fetchRows()
    const id = setInterval(fetchRows, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [exchange, coin])

  const daysToEvent = useMemo(() => {
    if (!eventDate) return null
    const d = (new Date(eventDate + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000
    return d > 0 ? d : null
  }, [eventDate])

  const rows = useMemo<StrategyRow[]>(() => {
    return rawRows
      .map(row => {
        const cost = direction === 'long' ? row.askCost : row.bidCost
        const thetaToEvent = daysToEvent != null ? Math.abs(row.theta) * daysToEvent : null
        return { ...row, cost, thetaToEvent }
      })
      .sort((a, b) => {
        if (daysToEvent != null) {
          const aV = a.vega > 0 ? (a.thetaToEvent ?? 0) / a.vega : 0
          const bV = b.vega > 0 ? (b.thetaToEvent ?? 0) / b.vega : 0
          return direction === 'short' ? bV - aV : aV - bV
        }
        return direction === 'short' ? b.beIVMove - a.beIVMove : a.beIVMove - b.beIVMove
      })
  }, [rawRows, direction, daysToEvent])

  const handleLoad = (row: StrategyRow) => {
    const chain = optionsData!.data[row.expiry]
    const call  = chain.calls.find((c: any) => c.strike === row.callStrike)!
    const put   = chain.puts.find((p: any)  => p.strike === row.putStrike)!
    const callPrices = (call as any).prices
    const putPrices  = (put  as any).prices

    let callPrice: number
    let putPrice: number
    let callEx: string
    let putEx: string

    if (direction === 'short') {
      callPrice = getBestBid(call, activeExchanges)
      putPrice  = getBestBid(put,  activeExchanges)
      callEx = (activeExchanges && callPrices)
        ? (Array.from(activeExchanges).find(ex => callPrices[ex]?.bid === callPrice) ?? exchange)
        : ((call as any).bestBidEx ?? exchange)
      putEx = (activeExchanges && putPrices)
        ? (Array.from(activeExchanges).find(ex => putPrices[ex]?.bid === putPrice) ?? exchange)
        : ((put as any).bestBidEx ?? exchange)
    } else {
      callPrice = getBestAsk(call, activeExchanges)
      putPrice  = getBestAsk(put,  activeExchanges)
      callEx = (activeExchanges && callPrices)
        ? (Array.from(activeExchanges).find(ex => callPrices[ex]?.ask === callPrice) ?? exchange)
        : ((call as any).bestAskEx ?? exchange)
      putEx = (activeExchanges && putPrices)
        ? (Array.from(activeExchanges).find(ex => putPrices[ex]?.ask === putPrice) ?? exchange)
        : ((put as any).bestAskEx ?? exchange)
    }

    const action = direction === 'short' ? 'sell' : 'buy'
    localStorage.setItem('arb_pending_strategy', JSON.stringify({
      coin,
      legs: [
        { type: 'call', action, strike: row.callStrike, expiry: row.expiry, price: callPrice, exchange: callEx, qty: 1 },
        { type: 'put',  action, strike: row.putStrike,  expiry: row.expiry, price: putPrice,  exchange: putEx,  qty: 1 },
      ],
    }))
    window.open('/builder', '_blank', 'noopener,noreferrer')
  }

  const fmtExpiry = (exp: string) =>
    new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const fmtStrike = (row: StrategyRow) =>
    row.type === 'straddle'
      ? row.callStrike.toLocaleString()
      : `${(row.callStrike / 1000).toFixed(0)}k / ${(row.putStrike / 1000).toFixed(0)}k`

  if (!rows.length) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        No data available — Greeks required (use Deribit, OKX, or Combined).
      </div>
    )
  }

  const isShort = direction === 'short'
  const worstBeIV = rows.reduce((m, r) => Math.max(m, r.beIVMove), 0) || 1
  const worstThetaPerVega = daysToEvent
    ? rows.reduce((m, r) => Math.max(m, (r.thetaToEvent ?? 0) / r.vega), 0) || 1
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Vega Scanner</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {isShort
              ? `Best straddle & strangle per expiry ranked by ${daysToEvent ? 'theta collected / vega to event' : 'highest BE IV move'} · selling premium`
              : `Best straddle & strangle per expiry ranked by ${daysToEvent ? 'theta bleed / vega to event' : 'BE IV move (cost / vega)'} · click to load into builder`
            }
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded overflow-hidden border border-rim text-[11px]">
            <button
              onClick={() => setDirection('long')}
              className={direction === 'long' ? 'px-2 py-0.5 bg-emerald-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
            >Long</button>
            <button
              onClick={() => setDirection('short')}
              className={direction === 'short' ? 'px-2 py-0.5 bg-rose-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
            >Short</button>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-3 whitespace-nowrap">Event date</label>
            <input
              type="date"
              value={eventDate}
              onChange={e => setEventDate(e.target.value)}
              className={`text-[11px] border border-rim rounded px-1.5 py-0.5 bg-card text-ink focus:outline-none focus:border-${isShort ? 'rose' : 'emerald'}-400`}
            />
            {eventDate && (
              <button onClick={() => setEventDate('')} className="text-[11px] text-ink-3 hover:text-ink">✕</button>
            )}
          </div>
          <span className="text-xs text-ink-3 font-mono">{coin} · {rows.length} rows</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b border-rim text-ink-2 text-[11px]">
              <th className="py-1 text-left font-medium">Type</th>
              <th className="py-1 text-left font-medium">Expiry</th>
              <th className="py-1 text-right font-medium">DTE</th>
              <th className="py-1 text-right font-medium">Strike(s)</th>
              <th className="py-1 text-right font-medium">{isShort ? 'Premium' : 'Cost'}</th>
              <th className="py-1 text-right font-medium">V</th>
              <th className="py-1 text-right font-medium">Θ/day</th>
              <th className="py-1 text-right font-medium text-ink-3">mIV</th>
              <th className="py-1 text-right font-medium text-ink-3">V/$</th>
              <th className={`py-1 text-right font-medium ${isShort ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>BE IV</th>
              {daysToEvent && (
                <th className="py-1 text-right font-medium text-amber-600 dark:text-amber-400">
                  Θ→{fmtExpiry(eventDate)}
                </th>
              )}
              <th className="py-1 w-16" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isBest = i === 0
              const isStrangle = row.type === 'strangle'
              const relWidth = Math.min(100, (row.beIVMove / worstBeIV) * 100)
              const thetaPerVega = row.thetaToEvent != null ? (row.thetaToEvent / row.vega) : null
              const relWidthEvent = worstThetaPerVega && thetaPerVega != null
                ? Math.min(100, (thetaPerVega / worstThetaPerVega) * 100)
                : 0
              return (
                <tr
                  key={`${row.expiry}-${row.type}`}
                  className={classNames('border-b border-rim hover:bg-muted cursor-pointer', {
                    'bg-emerald-50 dark:bg-emerald-950/20': isBest && !isShort && !daysToEvent,
                    'bg-rose-50 dark:bg-rose-950/20':       isBest && isShort && !daysToEvent,
                    'bg-amber-50 dark:bg-amber-950/20':     isBest && !!daysToEvent,
                  })}
                  onClick={() => handleLoad(row)}
                >
                  <td className="py-1.5">
                    <span className={classNames('text-[10px] font-semibold px-1.5 py-0.5 rounded', {
                      'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300': !isStrangle && !isShort,
                      'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300':             !isStrangle && isShort,
                      'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300':                 isStrangle,
                    })}>
                      {isStrangle ? 'Strangle' : 'Straddle'}
                    </span>
                  </td>
                  <td className="py-1.5 font-mono text-ink">{fmtExpiry(row.expiry)}</td>
                  <td className="py-1.5 text-right text-ink-2">{row.dte.toFixed(1)}d</td>
                  <td className="py-1.5 text-right font-mono text-ink">{fmtStrike(row)}</td>
                  <td className="py-1.5 text-right text-ink-2">${Math.round(row.cost).toLocaleString()}</td>
                  <td className="py-1.5 text-right text-ink-3">{row.vega.toFixed(1)}</td>
                  <td className="py-1.5 text-right text-ink-3">{row.theta.toFixed(1)}</td>
                  <td className="py-1.5 text-right text-ink-3">
                    {row.markIV > 0 ? (row.markIV * 100).toFixed(1) + '%' : '--'}
                  </td>
                  <td className="py-1.5 text-right text-ink-3 font-mono">
                    {row.vegaPerDollar.toFixed(4)}
                  </td>
                  <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                    'text-emerald-600 dark:text-emerald-400': isBest && !isShort && !daysToEvent,
                    'text-rose-600 dark:text-rose-400':       isBest && isShort && !daysToEvent,
                    'text-ink': (!isBest) || !!daysToEvent,
                  })}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isShort ? 'bg-rose-400' : 'bg-emerald-400'}`}
                          style={{ width: `${relWidth}%` }}
                        />
                      </div>
                      {row.beIVMove.toFixed(1)}%
                    </div>
                  </td>
                  {daysToEvent && (
                    <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                      'text-amber-600 dark:text-amber-400': isBest,
                      'text-ink': !isBest,
                    })}>
                      {row.thetaToEvent != null ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full" style={{ width: `${relWidthEvent}%` }} />
                          </div>
                          ${Math.round(row.thetaToEvent).toLocaleString()}
                        </div>
                      ) : '--'}
                    </td>
                  )}
                  <td className="py-1.5 text-right">
                    <span className="text-[10px] text-ink-3 hover:text-tone">
                      {isShort ? '→ Sell' : '→ Build'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
