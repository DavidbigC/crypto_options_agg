'use client'

import { useMemo, useState } from 'react'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'

interface SellScannerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
  activeExchanges?: Set<string>
}

interface SellRow {
  expiry: string
  dte: number
  optionType: 'call' | 'put'
  strike: number
  bid: number
  apr: number
  iv: number       // markVol * 100 (percent)
  ivApr: number    // iv / apr
  delta: number
}

type SortCol = 'expiry' | 'dte' | 'optionType' | 'strike' | 'bid' | 'apr' | 'iv' | 'ivApr' | 'delta'

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

export default function SellScanner({ optionsData, spotPrice, coin, exchange, activeExchanges }: SellScannerProps) {
  const [optionType, setOptionType] = useState<'calls' | 'puts' | 'both'>('both')
  const [strikeInput, setStrikeInput] = useState('')
  const [sortCol, setSortCol] = useState<SortCol | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const parsedStrike = strikeInput ? parseFloat(strikeInput) : null
  // Only apply the strike filter when the input is a meaningful number (>= 50% of spot)
  // This prevents partial deletes like "21" or "2" from picking the lowest OTM strike
  const targetStrike = parsedStrike && !isNaN(parsedStrike) && parsedStrike >= spotPrice * 0.5
    ? parsedStrike
    : null

  const rows = useMemo<SellRow[]>(() => {
    if (!optionsData || !spotPrice) return []

    const result: SellRow[] = []
    const now = Date.now()

    for (const expiry of optionsData.expirations) {
      const chain = optionsData.data[expiry]
      if (!chain) continue
      const expiryTs = new Date(expiry + 'T08:00:00Z').getTime()
      const dte = (expiryTs - now) / 86_400_000
      if (dte < 0.5) continue

      const processContracts = (contracts: any[], type: 'call' | 'put') => {
        if (optionType === 'calls' && type === 'put') return
        if (optionType === 'puts' && type === 'call') return

        const otm = contracts.filter(c =>
          type === 'call' ? c.strike > spotPrice : c.strike < spotPrice
        )
        if (!otm.length) return

        let contract: any
        if (targetStrike) {
          // For calls: pick nearest strike >= targetStrike; for puts: nearest strike <= targetStrike
          const qualified = type === 'call'
            ? otm.filter(c => c.strike >= targetStrike)
            : otm.filter(c => c.strike <= targetStrike)
          if (!qualified.length) return
          contract = qualified.reduce((best, c) =>
            Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best
          )
        } else {
          contract = otm.reduce((best, c) =>
            Math.abs(c.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? c : best
          )
        }

        const bid = getBestBid(contract, activeExchanges)
        if (!bid || bid <= 0) return
        if (!contract.markVol) return

        const collateral = type === 'call' ? spotPrice : contract.strike
        const apr = (bid / collateral) * (365 / dte) * 100
        const iv = contract.markVol ? contract.markVol * 100 : 0
        const ivApr = apr > 0 && iv > 0 ? iv / apr : 0
        const delta = Math.abs(contract.delta ?? 0)

        result.push({ expiry, dte, optionType: type, strike: contract.strike, bid, apr, iv, ivApr, delta })
      }

      processContracts(chain.calls, 'call')
      processContracts(chain.puts, 'put')
    }

    return result.sort((a, b) => {
      if (sortCol) {
        let diff: number
        if (sortCol === 'expiry') diff = a.expiry.localeCompare(b.expiry)
        else if (sortCol === 'optionType') diff = a.optionType.localeCompare(b.optionType)
        else diff = (a[sortCol] as number) - (b[sortCol] as number)
        return sortDir === 'desc' ? -diff : diff
      }
      return b.apr - a.apr
    })
  }, [optionsData, spotPrice, optionType, targetStrike, activeExchanges, sortCol, sortDir])

  const handleSortCol = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const fmtExpiry = (exp: string) =>
    new Date(exp + 'T08:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

  const handleLoad = (row: SellRow) => {
    const chain = optionsData!.data[row.expiry]
    const contracts = row.optionType === 'call' ? chain.calls : chain.puts
    const contract = contracts.find((c: any) => c.strike === row.strike)!
    const prices = (contract as any).prices

    const price = getBestBid(contract, activeExchanges)
    const ex = (activeExchanges && prices)
      ? (Array.from(activeExchanges).find(e => prices[e]?.bid === price) ?? exchange)
      : ((contract as any).bestBidEx ?? exchange)

    localStorage.setItem('arb_pending_strategy', JSON.stringify({
      coin,
      legs: [
        { type: row.optionType, action: 'sell', strike: row.strike, expiry: row.expiry, price, exchange: ex, qty: 1 },
      ],
    }))
    window.open('/builder', '_blank', 'noopener,noreferrer')
  }

  if (!optionsData) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        No data available.
      </div>
    )
  }

  if (!spotPrice || spotPrice <= 0) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        Waiting for spot price…
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        {targetStrike
          ? `No OTM options found at or above $${targetStrike.toLocaleString()} — try a lower strike.`
          : 'No OTM options available.'
        }
      </div>
    )
  }

  const bestApr = rows.reduce((m, r) => Math.max(m, r.apr), 0) || 1
  const maxAprRow = rows.reduce((best, r) => r.apr > best.apr ? r : best, rows[0])
  const ind = (col: SortCol) => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''
  const thCls = (align: 'left' | 'right', extra = '') =>
    `py-1 text-${align} font-medium cursor-pointer select-none hover:text-ink ${extra}`

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Sell Scanner</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            OTM options ranked by APR · click to load into builder
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded overflow-hidden border border-rim text-[11px]">
            <button
              onClick={() => setOptionType('calls')}
              className={optionType === 'calls' ? 'px-2 py-0.5 bg-sky-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
            >Calls</button>
            <button
              onClick={() => setOptionType('puts')}
              className={optionType === 'puts' ? 'px-2 py-0.5 bg-rose-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
            >Puts</button>
            <button
              onClick={() => setOptionType('both')}
              className={optionType === 'both' ? 'px-2 py-0.5 bg-violet-500 text-white' : 'px-2 py-0.5 text-ink-3 hover:text-ink'}
            >Both</button>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-ink-3 whitespace-nowrap">Strike</label>
            <input
              type="text"
              inputMode="numeric"
              value={strikeInput}
              onChange={e => setStrikeInput(e.target.value)}
              placeholder="ATM"
              className="text-[11px] border border-rim rounded px-1.5 py-0.5 bg-card text-ink focus:outline-none focus:border-emerald-400 w-24"
            />
            {strikeInput && (
              <button onClick={() => setStrikeInput('')} className="text-[11px] text-ink-3 hover:text-ink">✕</button>
            )}
          </div>
          <span className="text-xs text-ink-3 font-mono">{coin} · {rows.length} rows</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b border-rim text-ink-2 text-[11px]">
              <th className={thCls('left')} onClick={() => handleSortCol('optionType')}>Type{ind('optionType')}</th>
              <th className={thCls('left')} onClick={() => handleSortCol('expiry')}>Expiry{ind('expiry')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('dte')}>DTE{ind('dte')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('strike')}>Strike{ind('strike')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('bid')}>Bid{ind('bid')}</th>
              <th className={thCls('right', 'text-emerald-600 dark:text-emerald-400')} onClick={() => handleSortCol('apr')}>APR{ind('apr')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('iv')}>IV{ind('iv')}</th>
              <th className={thCls('right', 'text-emerald-600 dark:text-emerald-400')} onClick={() => handleSortCol('ivApr')} title="IV ÷ APR — higher means you are selling expensive vol relative to the yield">IV/APR{ind('ivApr')}</th>
              <th className={thCls('right')} onClick={() => handleSortCol('delta')}>|Δ|{ind('delta')}</th>
              <th className="py-1 w-16" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isBest = row === maxAprRow
              const isCall = row.optionType === 'call'
              const relWidth = Math.min(100, (row.apr / bestApr) * 100)
              return (
                <tr
                  key={`${row.expiry}-${row.optionType}-${row.strike}`}
                  className={classNames('border-b border-rim hover:bg-muted cursor-pointer', {
                    'bg-emerald-50 dark:bg-emerald-950/20': isBest,
                  })}
                  onClick={() => handleLoad(row)}
                >
                  <td className="py-1.5">
                    <span className={classNames('text-[10px] font-semibold px-1.5 py-0.5 rounded', {
                      'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300':    isCall,
                      'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300': !isCall,
                    })}>
                      {isCall ? 'Call' : 'Put'}
                    </span>
                  </td>
                  <td className="py-1.5 font-mono text-ink">{fmtExpiry(row.expiry)}</td>
                  <td className="py-1.5 text-right text-ink-2">{row.dte.toFixed(1)}d</td>
                  <td className="py-1.5 text-right font-mono text-ink">{row.strike.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-ink-2">${row.bid.toFixed(2)}</td>
                  <td className={classNames('py-1.5 text-right font-semibold font-mono', {
                    'text-emerald-600 dark:text-emerald-400': isBest,
                    'text-ink': !isBest,
                  })}>
                    <div className="flex items-center justify-end gap-1.5">
                      <div className="w-12 h-1 bg-rim rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${relWidth}%` }} />
                      </div>
                      {row.apr.toFixed(1)}%
                    </div>
                  </td>
                  <td className="py-1.5 text-right text-ink-3">{row.iv > 0 ? row.iv.toFixed(1) + '%' : '--'}</td>
                  <td className={classNames('py-1.5 text-right font-mono', {
                    'text-emerald-600 dark:text-emerald-400': isBest,
                    'text-ink-2': !isBest,
                  })}>
                    {row.ivApr > 0 ? row.ivApr.toFixed(2) : '--'}
                  </td>
                  <td className="py-1.5 text-right text-ink-3">{row.delta.toFixed(2)}</td>
                  <td className="py-1.5 text-right">
                    <span className="text-[10px] text-ink-3 hover:text-tone">→ Sell</span>
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
