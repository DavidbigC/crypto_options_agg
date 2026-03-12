'use client'

import { useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'

interface GammaScannerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
  activeExchanges?: Set<string>
}

interface GammaRow {
  expiry: string
  dte: number
  type: 'straddle' | 'strangle'
  callStrike: number
  putStrike: number
  askCost: number
  bidCost: number
  gamma: number
  theta: number
  be: number
  bePct: number
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
  gammaDollar: number   // gamma / cost
  gammaTheta: number    // gamma / |theta|
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

type SortCol = 'type' | 'expiry' | 'dte' | 'callStrike' | 'cost' | 'gamma' | 'theta' | 'be' | 'bePct' | 'gammaDollar' | 'gammaTheta' | 'beToEvent'

export default function GammaScanner({ optionsData, spotPrice, coin, exchange, activeExchanges }: GammaScannerProps) {
  const [eventDate, setEventDate] = useState('')
  const [direction, setDirection] = useState<'long' | 'short'>('long')
  const [rawRows, setRawRows] = useState<GammaRow[]>([])
  const [sortCol, setSortCol] = useState<SortCol | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const exchangesParam = exchange === 'combined' && activeExchanges
    ? `?exchanges=${Array.from(activeExchanges).join(',')}`
    : ''

  useEffect(() => {
    setRawRows([])
    let cancelled = false
    const fetchRows = () => {
      fetch(`/api/scanners/${exchange}/${coin}${exchangesParam}`)
        .then(r => r.json())
        .then(data => {
          if (!cancelled) setRawRows(data.gamma ?? [])
        })
        .catch(() => {})
    }
    fetchRows()
    const id = setInterval(fetchRows, 3000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [exchange, coin, exchangesParam])

  const daysToEvent = useMemo(() => {
    if (!eventDate) return null
    const d = (new Date(eventDate + 'T08:00:00Z').getTime() - Date.now()) / 86_400_000
    return d > 0 ? d : null
  }, [eventDate])

  const rows = useMemo<StrategyRow[]>(() => {
    const eventTs = eventDate ? new Date(eventDate + 'T08:00:00Z').getTime() : null
    const filtered = eventTs != null
      ? rawRows.filter(row => new Date(row.expiry + 'T08:00:00Z').getTime() >= eventTs)
      : rawRows
    return filtered
      .map(row => {
        const cost = direction === 'long' ? row.askCost : row.bidCost
        const beToEvent =
          daysToEvent && row.gamma > 0
            ? Math.sqrt(2 * daysToEvent * Math.abs(row.theta) / row.gamma)
            : null
        const gammaDollar = cost > 0 ? row.gamma / cost : 0
        const gammaTheta  = row.theta !== 0 ? row.gamma / Math.abs(row.theta) : 0
        return { ...row, cost, beToEvent, gammaDollar, gammaTheta }
      })
      .sort((a, b) => {
        if (sortCol) {
          let diff: number
          if (sortCol === 'type')   diff = a.type.localeCompare(b.type)
          else if (sortCol === 'expiry') diff = a.expiry.localeCompare(b.expiry)
          else if (sortCol === 'beToEvent') diff = (a.beToEvent ?? Infinity) - (b.beToEvent ?? Infinity)
          else diff = (a[sortCol] as number) - (b[sortCol] as number)
          return sortDir === 'desc' ? -diff : diff
        }
        if (daysToEvent != null) {
          return direction === 'short'
            ? (b.beToEvent ?? 0) - (a.beToEvent ?? 0)
            : (a.beToEvent ?? Infinity) - (b.beToEvent ?? Infinity)
        }
        return direction === 'short' ? b.be - a.be : a.be - b.be
      })
  }, [rawRows, direction, daysToEvent, eventDate, sortCol, sortDir])

  const handleSortCol = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const handleLoad = (row: StrategyRow) => {
    const chain = optionsData!.data[row.expiry]
    const call  = chain.calls.find(c => c.strike === row.callStrike)!
    const put   = chain.puts.find(p => p.strike === row.putStrike)!
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
  const accentColor = isShort ? 'rose' : 'violet'

  const ind = (col: SortCol) => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''
  const thCls = (align: 'left' | 'right', extra = '') =>
    `py-1 text-${align} font-medium cursor-pointer select-none hover:text-ink ${extra}`
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
            {isShort
              ? `Best straddle & strangle per expiry ranked by ${daysToEvent ? 'max move to event' : 'highest BE/day'} · selling premium`
              : `Best straddle & strangle per expiry ranked by ${daysToEvent ? 'break-even move to event' : 'BE/day'} · click to load into builder`
            }
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded overflow-hidden border border-rim text-[11px]">
            <button
              onClick={() => setDirection('long')}
              className={direction === 'long' ? 'px-2 py-0.5 bg-violet-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
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
              className={`text-[11px] border border-rim rounded px-1.5 py-0.5 bg-card text-ink focus:outline-none focus:border-${accentColor}-400`}
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
              <th className={thCls('left')} onClick={() => handleSortCol('type')}>Type{ind('type')}</th>
              <th className={thCls('left')} onClick={() => handleSortCol('expiry')}>Expiry{ind('expiry')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('dte')}>DTE{ind('dte')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('callStrike')}>Strike(s){ind('callStrike')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('cost')}>{isShort ? 'Premium' : 'Cost'}{ind('cost')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('gamma')}>Γ{ind('gamma')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('theta')}>Θ/day{ind('theta')}</th>
              <th className={thCls('right', `text-${accentColor}-600 dark:text-${accentColor}-400`)} onClick={() => handleSortCol('be')}>BE/day{ind('be')}</th>
              <th className={thCls('right', `text-${accentColor}-600 dark:text-${accentColor}-400`)} onClick={() => handleSortCol('bePct')}>BE%{ind('bePct')}</th>
              <th className={thCls('right', 'text-ink-3')} onClick={() => handleSortCol('gammaDollar')} title="Gamma per dollar spent. Higher = more gamma per $ — better for longs, worse for shorts.">Γ/${ind('gammaDollar')}</th>
              <th className={thCls('right', 'text-ink-3')} onClick={() => handleSortCol('gammaTheta')} title="Gamma per dollar of daily theta. Higher = more gamma per unit of carry — better for longs, worse for shorts.">Γ/Θ{ind('gammaTheta')}</th>
              <th className={classNames(thCls('right', 'text-amber-600 dark:text-amber-400'), !daysToEvent && 'invisible')} onClick={() => daysToEvent ? handleSortCol('beToEvent') : undefined}>BE→{daysToEvent ? fmtExpiry(eventDate) : ''}{daysToEvent ? ind('beToEvent') : ''}</th>
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
                  key={`${row.expiry}-${row.type}-${row.callStrike}-${row.putStrike}`}
                  className={classNames('border-b border-rim hover:bg-muted cursor-pointer', {
                    'bg-violet-50 dark:bg-violet-950/20': isBest && !isShort && !daysToEvent,
                    'bg-rose-50 dark:bg-rose-950/20':   isBest && isShort && !daysToEvent,
                    'bg-amber-50 dark:bg-amber-950/20': isBest && !!daysToEvent,
                  })}
                  onClick={() => handleLoad(row)}
                >
                  <td className="py-1.5">
                    <span className={classNames('text-[10px] font-semibold px-1.5 py-0.5 rounded', {
                      'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300': !isStrangle && !isShort,
                      'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300':         !isStrangle && isShort,
                      'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300':             isStrangle,
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
                    'text-violet-600 dark:text-violet-400': isBest && !isShort && !daysToEvent,
                    'text-rose-600 dark:text-rose-400':     isBest && isShort && !daysToEvent,
                    'text-ink': (!isBest) || !!daysToEvent,
                  })}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isShort ? 'bg-rose-400' : 'bg-violet-400'}`}
                          style={{ width: `${relWidth}%` }}
                        />
                      </div>
                      ${Math.round(row.be).toLocaleString()}
                    </div>
                  </td>
                  <td className={classNames('py-1.5 text-right font-mono', {
                    'text-violet-600 dark:text-violet-400': isBest && !isShort && !daysToEvent,
                    'text-rose-600 dark:text-rose-400':     isBest && isShort && !daysToEvent,
                    'text-ink-2': (!isBest) || !!daysToEvent,
                  })}>
                    {row.bePct.toFixed(2)}%
                  </td>
                  <td className="py-1.5 text-right font-mono text-ink-3" title="Gamma per dollar spent">
                    {row.gammaDollar.toExponential(2)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-ink-3" title="Gamma per dollar of daily theta">
                    {row.gammaTheta.toExponential(2)}
                  </td>
                  <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                    'text-amber-600 dark:text-amber-400': daysToEvent && isBest,
                    'text-ink': daysToEvent && !isBest,
                    'invisible': !daysToEvent,
                  })}>
                    {daysToEvent && row.beToEvent ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                          <div className="h-full bg-amber-400 rounded-full" style={{ width: `${relWidthEvent}%` }} />
                        </div>
                        ${Math.round(row.beToEvent).toLocaleString()}
                      </div>
                    ) : '--'}
                  </td>
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
