'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'
import { calcBreakEven } from '@/lib/blackScholes'
import { filterExpirations } from '@/lib/filterExpirations'

interface GammaScreenerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
}

interface StraddleRow {
  expiry: string
  dte: number
  strike: number
  cost: number
  gamma: number
  theta: number
  be: number
  bePct: number
  beToEvent: number | null
}

export default function GammaScreener({ optionsData, spotPrice, coin, exchange }: GammaScreenerProps) {
  const router = useRouter()
  const [eventDate, setEventDate] = useState('')

  const daysToEvent = useMemo(() => {
    if (!eventDate) return null
    const d = (new Date(eventDate + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000
    return d > 0 ? d : null
  }, [eventDate])

  const rows = useMemo<StraddleRow[]>(() => {
    if (!optionsData || !spotPrice) return []
    const expirations = filterExpirations(optionsData.expirations)
    const results: StraddleRow[] = []

    for (const expiry of expirations) {
      const chain = optionsData.data[expiry]
      if (!chain?.calls?.length || !chain?.puts?.length) continue

      const allStrikes = Array.from(new Set([
        ...chain.calls.map(c => c.strike),
        ...chain.puts.map(p => p.strike),
      ]))
      const atm = allStrikes.reduce((prev, curr) =>
        Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
      )

      const call = chain.calls.find(c => c.strike === atm)
      const put  = chain.puts.find(p => p.strike === atm)
      if (!call || !put) continue

      const callAsk = (call as any).bestAsk ?? call.ask
      const putAsk  = (put  as any).bestAsk ?? put.ask
      if (!callAsk || !putAsk) continue

      const priceMultiplier = exchange === 'okx' && spotPrice > 0 ? spotPrice : 1
      const cost  = (callAsk + putAsk) * priceMultiplier
      const gamma = (call.gamma || 0) + (put.gamma || 0)
      const theta = (call.theta || 0) + (put.theta || 0)
      const be    = calcBreakEven(theta, gamma)
      if (!be) continue

      const dte = (new Date(expiry + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000
      const beToEvent = daysToEvent && gamma > 0
        ? Math.sqrt(2 * daysToEvent * Math.abs(theta) / gamma)
        : null

      results.push({
        expiry,
        dte: Math.max(0, dte),
        strike: atm,
        cost,
        gamma,
        theta,
        be,
        bePct: (be / spotPrice) * 100,
        beToEvent,
      })
    }

    return results.sort((a, b) =>
      daysToEvent
        ? (a.beToEvent ?? Infinity) - (b.beToEvent ?? Infinity)
        : a.be - b.be
    )
  }, [optionsData, spotPrice, daysToEvent])

  const handleLoad = (row: StraddleRow) => {
    const chain = optionsData!.data[row.expiry]
    const call  = chain.calls.find(c => c.strike === row.strike)!
    const put   = chain.puts.find(p => p.strike === row.strike)!
    const callEx  = (call as any).bestAskEx ?? exchange
    const putEx   = (put  as any).bestAskEx ?? exchange
    const callAsk = (call as any).bestAsk ?? call.ask
    const putAsk  = (put  as any).bestAsk ?? put.ask

    localStorage.setItem('arb_pending_strategy', JSON.stringify({
      coin,
      legs: [
        { type: 'call', action: 'buy', strike: row.strike, expiry: row.expiry, price: callAsk, exchange: callEx, qty: 1 },
        { type: 'put',  action: 'buy', strike: row.strike, expiry: row.expiry, price: putAsk,  exchange: putEx,  qty: 1 },
      ],
    }))
    router.push('/builder')
  }

  const fmtExpiry = (exp: string) =>
    new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (!rows.length) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        No straddle data available — Greeks required (use Deribit, OKX, or Combined).
      </div>
    )
  }

  const worstBe = rows[rows.length - 1]?.be || rows[0].be
  const worstBeToEvent = daysToEvent
    ? rows.reduce((m, r) => Math.max(m, r.beToEvent ?? 0), 0) || 1
    : null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Gamma Scanner</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            ATM straddles ranked by {daysToEvent ? 'break-even move to event' : 'cheapest break-even daily move'} · click to load into builder
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
          <span className="text-xs text-ink-3 font-mono">{coin} · {rows.length} expiries</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b border-rim text-ink-2 text-[11px]">
              <th className="py-1 text-left font-medium">Expiry</th>
              <th className="py-1 text-right font-medium">DTE</th>
              <th className="py-1 text-right font-medium">Strike</th>
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
              const relWidth = Math.min(100, (row.be / worstBe) * 100)
              const relWidthEvent = worstBeToEvent && row.beToEvent
                ? Math.min(100, (row.beToEvent / worstBeToEvent) * 100)
                : 0
              return (
                <tr
                  key={row.expiry}
                  className={classNames('border-b border-rim hover:bg-muted cursor-pointer', {
                    'bg-violet-50 dark:bg-violet-950/20': isBest && !daysToEvent,
                    'bg-amber-50 dark:bg-amber-950/20': isBest && !!daysToEvent,
                  })}
                  onClick={() => handleLoad(row)}
                >
                  <td className="py-1.5 font-mono text-ink">{fmtExpiry(row.expiry)}</td>
                  <td className="py-1.5 text-right text-ink-2">{row.dte.toFixed(1)}d</td>
                  <td className="py-1.5 text-right font-mono text-ink">{row.strike.toLocaleString()}</td>
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
