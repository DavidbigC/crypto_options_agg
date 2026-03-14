'use client'

import React from 'react'
import classNames from 'classnames'

// Strategy pip colors — ordered for display
const STRATEGY_PIPS: { key: string; color: string; title: string }[] = [
  { key: 'box_long',          color: 'bg-amber-500',   title: 'Long Box'          },
  { key: 'box_short',         color: 'bg-orange-500',  title: 'Short Box'         },
  { key: 'call_monotonicity', color: 'bg-emerald-600', title: 'Call Monotonicity' },
  { key: 'put_monotonicity',  color: 'bg-rose-600',    title: 'Put Monotonicity'  },
  { key: 'call_butterfly',    color: 'bg-violet-600',  title: 'Call Butterfly'    },
  { key: 'put_butterfly',     color: 'bg-purple-600',  title: 'Put Butterfly'     },
  { key: 'calendar_arb',      color: 'bg-sky-600',     title: 'Calendar Arb'      },
  { key: 'pcp_conversion',    color: 'bg-teal-600',    title: 'Conversion'        },
  { key: 'pcp_reversal',      color: 'bg-cyan-600',    title: 'Reversal'          },
]

interface ExpirationTabsProps {
  expirations: string[]
  selected: string
  onSelect: (expiration: string) => void
  optionsCounts: Record<string, { calls: number; puts: number }>
  arbExpiryStrategies?: Map<string, Set<string>>
  expiryExchangeCounts?: Record<string, { bybit: number; okx: number; deribit: number; derive: number; binance: number }>
}

// Exchange gradient colors — orange=Bybit, zinc=OKX, blue=Deribit, pink=Derive, yellow=Binance
const EX_RGB = {
  bybit:   '234,88,12',    // orange-600
  okx:     '82,82,91',     // zinc-600
  deribit: '37,99,235',    // blue-600
  derive:  '236,72,153',   // pink-500
  binance: '250,204,21',   // yellow-400
} as const

function buildExchangeSegments(counts: { bybit: number; okx: number; deribit: number; derive: number; binance: number }) {
  return (['bybit', 'okx', 'deribit', 'derive', 'binance'] as const)
    .filter(ex => counts[ex] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .map(ex => ({
      exchange: ex,
      count: counts[ex],
      color: `rgb(${EX_RGB[ex]})`,
    }))
}

export default function ExpirationTabs({ expirations = [], selected, onSelect, optionsCounts, arbExpiryStrategies, expiryExchangeCounts }: ExpirationTabsProps) {
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    if (date.toDateString() === today.toDateString()) return 'TODAY'
    if (date.toDateString() === tomorrow.toDateString()) return 'TMRW'
    const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase()
    const day = date.getDate().toString().padStart(2, '0')
    return `${day}-${month.substring(0, 3)}-${date.getFullYear().toString().substring(2)}`
  }

  return (
    <div className="flex overflow-x-auto gap-1.5 pb-0.5">
      {expirations.map(expiration => {
        const isSelected = selected === expiration
        const counts = optionsCounts[expiration]
        const total = counts ? counts.calls + counts.puts : 0
        const exCounts   = expiryExchangeCounts?.[expiration]
        const strategies = arbExpiryStrategies?.get(expiration)
        return (
          <button
            key={expiration}
            onClick={() => onSelect(expiration)}
            className={classNames(
              'relative min-w-[5.9rem] flex-shrink-0 overflow-hidden rounded-[0.95rem] border px-3 pt-2 pb-2.5 text-left text-[11px] font-medium whitespace-nowrap transition-colors',
              isSelected
                ? 'border-rim bg-card text-ink shadow-sm'
                : 'border-rim/80 bg-card/55 text-ink-2 hover:text-ink'
            )}
          >
            <div className="flex h-2.5 items-center gap-0.5">
              {strategies && STRATEGY_PIPS.filter(p => strategies.has(p.key)).map(p => (
                <span
                  key={p.key}
                  title={p.title}
                  className={classNames('w-1.5 h-1.5 rounded-full flex-shrink-0', p.color)}
                />
              ))}
            </div>
            <div className={classNames('mt-1 font-mono', isSelected ? 'text-tone' : 'text-ink')}>
              {formatDate(expiration)}
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              {counts ? `${total} contracts` : '\u00a0'}
            </div>
            {exCounts ? (
              <div
                className={classNames(
                  'absolute bottom-1.5 left-2 right-2 flex h-1 overflow-hidden rounded-full',
                  isSelected ? 'opacity-100' : 'opacity-75',
                )}
              >
                {buildExchangeSegments(exCounts).map(({ exchange, count, color }) => (
                  <span
                    key={exchange}
                    title={`${exchange.toUpperCase()}: ${count}`}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{ backgroundColor: color, flexGrow: count }}
                  />
                ))}
              </div>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
