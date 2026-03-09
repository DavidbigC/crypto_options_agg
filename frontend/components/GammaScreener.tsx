'use client'

import { useMemo, useState } from 'react'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'
import { calcBreakEven } from '@/lib/blackScholes'
import { filterExpirations } from '@/lib/filterExpirations'

interface GammaScreenerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
  activeExchanges?: Set<string>
}

interface StrategyRow {
  expiry: string
  dte: number
  type: 'straddle' | 'strangle'
  callStrike: number
  putStrike: number
  cost: number
  gamma: number
  theta: number
  be: number
  bePct: number
  beToEvent: number | null
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

export default function GammaScreener({ optionsData, spotPrice, coin, exchange, activeExchanges }: GammaScreenerProps) {
  const [eventDate, setEventDate] = useState('')

  const daysToEvent = useMemo(() => {
    if (!eventDate) return null
    const d = (new Date(eventDate + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000
    return d > 0 ? d : null
  }, [eventDate])

  const rows = useMemo<StrategyRow[]>(() => {
    if (!optionsData || !spotPrice) return []
    const expirations = filterExpirations(optionsData.expirations)
    const results: StrategyRow[] = []
    const priceMultiplier = exchange === 'okx' && spotPrice > 0 ? spotPrice : 1

    const makeBeToEvent = (theta: number, gamma: number) =>
      daysToEvent && gamma > 0
        ? Math.sqrt(2 * daysToEvent * Math.abs(theta) / gamma)
        : null

    for (const expiry of expirations) {
      const chain = optionsData.data[expiry]
      if (!chain?.calls?.length || !chain?.puts?.length) continue

      const dte = Math.max(0, (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000)

      // ATM straddle
      const allStrikes = Array.from(new Set([
        ...chain.calls.map(c => c.strike),
        ...chain.puts.map(p => p.strike),
      ]))
      const atm = allStrikes.reduce((prev, curr) =>
        Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
      )
      const atmCall = chain.calls.find(c => c.strike === atm)
      const atmPut  = chain.puts.find(p => p.strike === atm)
      if (atmCall && atmPut) {
        const callAsk = getBestAsk(atmCall, activeExchanges)
        const putAsk  = getBestAsk(atmPut, activeExchanges)
        if (callAsk && putAsk) {
          const gamma = (atmCall.gamma || 0) + (atmPut.gamma || 0)
          const theta = (atmCall.theta || 0) + (atmPut.theta || 0)
          const be    = calcBreakEven(theta, gamma)
          if (be) {
            results.push({
              expiry, dte, type: 'straddle',
              callStrike: atm, putStrike: atm,
              cost: (callAsk + putAsk) * priceMultiplier,
              gamma, theta, be,
              bePct: (be / spotPrice) * 100,
              beToEvent: makeBeToEvent(theta, gamma),
            })
          }
        }
      }

      // Best delta-neutral strangle: iterate OTM call × OTM put pairs
      // Require |call.delta + put.delta| < 0.15 for symmetric up/down P&L.
      // Fall back to unfiltered if no delta data is available.
      const DELTA_TOL = 0.15
      const otmCalls = chain.calls.filter(c => c.strike > spotPrice && (c.gamma || 0) > 0 && c.theta)
      const otmPuts  = chain.puts.filter(p => p.strike < spotPrice && (p.gamma || 0) > 0 && p.theta)
      const hasDelta = otmCalls.some(c => c.delta !== undefined && c.delta !== 0)

      let bestStrangle: StrategyRow | null = null
      for (const call of otmCalls) {
        for (const put of otmPuts) {
          if (hasDelta && Math.abs((call.delta || 0) + (put.delta || 0)) > DELTA_TOL) continue
          const gamma = (call.gamma || 0) + (put.gamma || 0)
          const theta = (call.theta || 0) + (put.theta || 0)
          const be    = calcBreakEven(theta, gamma)
          if (!be) continue
          if (bestStrangle && be >= bestStrangle.be) continue
          const callAsk = getBestAsk(call, activeExchanges)
          const putAsk  = getBestAsk(put, activeExchanges)
          if (!callAsk || !putAsk) continue
          bestStrangle = {
            expiry, dte, type: 'strangle',
            callStrike: call.strike, putStrike: put.strike,
            cost: (callAsk + putAsk) * priceMultiplier,
            gamma, theta, be,
            bePct: (be / spotPrice) * 100,
            beToEvent: makeBeToEvent(theta, gamma),
          }
        }
      }
      if (bestStrangle) results.push(bestStrangle)
    }

    return results.sort((a, b) =>
      daysToEvent
        ? (a.beToEvent ?? Infinity) - (b.beToEvent ?? Infinity)
        : a.be - b.be
    )
  }, [optionsData, spotPrice, exchange, daysToEvent, activeExchanges])

  const handleLoad = (row: StrategyRow) => {
    const chain = optionsData!.data[row.expiry]
    const call  = chain.calls.find(c => c.strike === row.callStrike)!
    const put   = chain.puts.find(p => p.strike === row.putStrike)!
    const callAsk = getBestAsk(call, activeExchanges)
    const putAsk  = getBestAsk(put, activeExchanges)
    const callPrices = (call as any).prices
    const putPrices  = (put  as any).prices
    const callEx  = (activeExchanges && callPrices)
      ? (Array.from(activeExchanges).find(ex => callPrices[ex]?.ask === callAsk) ?? exchange)
      : ((call as any).bestAskEx ?? exchange)
    const putEx   = (activeExchanges && putPrices)
      ? (Array.from(activeExchanges).find(ex => putPrices[ex]?.ask === putAsk) ?? exchange)
      : ((put as any).bestAskEx ?? exchange)

    localStorage.setItem('arb_pending_strategy', JSON.stringify({
      coin,
      legs: [
        { type: 'call', action: 'buy', strike: row.callStrike, expiry: row.expiry, price: callAsk, exchange: callEx, qty: 1 },
        { type: 'put',  action: 'buy', strike: row.putStrike,  expiry: row.expiry, price: putAsk,  exchange: putEx,  qty: 1 },
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

  const worstBe = rows.reduce((m, r) => Math.max(m, r.be), 0) || 1
  const worstBeToEvent = daysToEvent
    ? rows.reduce((m, r) => Math.max(m, r.beToEvent ?? 0), 0) || 1
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Gamma Scanner</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            Best straddle &amp; strangle per expiry ranked by {daysToEvent ? 'break-even move to event' : 'BE/day'} · click to load into builder
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-3 whitespace-nowrap">Event date</label>
            <input
              type="date"
              value={eventDate}
              onChange={e => setEventDate(e.target.value)}
              className="text-[11px] border border-rim rounded px-1.5 py-0.5 bg-card text-ink focus:outline-none focus:border-violet-400"
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
              <th className="py-1 text-right font-medium">Cost</th>
              <th className="py-1 text-right font-medium">Γ</th>
              <th className="py-1 text-right font-medium">Θ/day</th>
              <th className="py-1 text-right font-medium text-violet-600 dark:text-violet-400">BE/day</th>
              <th className="py-1 text-right font-medium text-violet-600 dark:text-violet-400">BE%</th>
              {daysToEvent && (
                <th className="py-1 text-right font-medium text-amber-600 dark:text-amber-400">
                  BE→{fmtExpiry(eventDate)}
                </th>
              )}
              <th className="py-1 w-16" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isBest = i === 0
              const isStrangle = row.type === 'strangle'
              const relWidth = Math.min(100, (row.be / worstBe) * 100)
              const relWidthEvent = worstBeToEvent && row.beToEvent
                ? Math.min(100, (row.beToEvent / worstBeToEvent) * 100)
                : 0
              return (
                <tr
                  key={`${row.expiry}-${row.type}`}
                  className={classNames('border-b border-rim hover:bg-muted cursor-pointer', {
                    'bg-violet-50 dark:bg-violet-950/20': isBest && !daysToEvent,
                    'bg-amber-50 dark:bg-amber-950/20': isBest && !!daysToEvent,
                  })}
                  onClick={() => handleLoad(row)}
                >
                  <td className="py-1.5">
                    <span className={classNames('text-[10px] font-semibold px-1.5 py-0.5 rounded', {
                      'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300': !isStrangle,
                      'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300': isStrangle,
                    })}>
                      {isStrangle ? 'Strangle' : 'Straddle'}
                    </span>
                  </td>
                  <td className="py-1.5 font-mono text-ink">{fmtExpiry(row.expiry)}</td>
                  <td className="py-1.5 text-right text-ink-2">{row.dte.toFixed(1)}d</td>
                  <td className="py-1.5 text-right font-mono text-ink">{fmtStrike(row)}</td>
                  <td className="py-1.5 text-right text-ink-2">${Math.round(row.cost).toLocaleString()}</td>
                  <td className="py-1.5 text-right text-ink-3">{row.gamma.toFixed(5)}</td>
                  <td className="py-1.5 text-right text-ink-3">{row.theta.toFixed(1)}</td>
                  <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                    'text-violet-600 dark:text-violet-400': isBest && !daysToEvent,
                    'text-ink': !isBest || !!daysToEvent,
                  })}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                        <div className="h-full bg-violet-400 rounded-full" style={{ width: `${relWidth}%` }} />
                      </div>
                      ${Math.round(row.be).toLocaleString()}
                    </div>
                  </td>
                  <td className={classNames('py-1.5 text-right font-mono', {
                    'text-violet-600 dark:text-violet-400': isBest && !daysToEvent,
                    'text-ink-2': !isBest || !!daysToEvent,
                  })}>
                    {row.bePct.toFixed(2)}%
                  </td>
                  {daysToEvent && (
                    <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                      'text-amber-600 dark:text-amber-400': isBest,
                      'text-ink': !isBest,
                    })}>
                      {row.beToEvent ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full" style={{ width: `${relWidthEvent}%` }} />
                          </div>
                          ${Math.round(row.beToEvent).toLocaleString()}
                        </div>
                      ) : '--'}
                    </td>
                  )}
                  <td className="py-1.5 text-right">
                    <span className="text-[10px] text-ink-3 hover:text-tone">→ Build</span>
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
