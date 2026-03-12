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
    <div className="flex overflow-x-auto gap-1 pb-0.5">
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
              'relative flex-shrink-0 px-2.5 pt-1 pb-2 rounded text-[10px] font-mono font-medium transition-colors whitespace-nowrap border overflow-hidden',
              isSelected
                ? 'bg-tone text-white border-tone'
                : 'bg-muted text-ink-2 hover:text-ink border-rim'
            )}
          >
            <div className="flex items-center justify-center gap-0.5 h-2.5">
              {strategies && STRATEGY_PIPS.filter(p => strategies.has(p.key)).map(p => (
                <span
                  key={p.key}
                  title={p.title}
                  className={classNames('w-1.5 h-1.5 rounded-full flex-shrink-0', p.color)}
                />
              ))}
            </div>
            <div>{formatDate(expiration)}</div>
            <div className={classNames('text-[9px] mt-0.5', isSelected ? 'text-white/70' : 'text-ink-3')}>
              {counts ? total : '\u00a0'}
            </div>
            {exCounts ? (
              <div
                className={classNames(
                  'absolute left-1.5 right-1.5 bottom-1 flex h-1.5 overflow-hidden rounded-full',
                  isSelected ? 'opacity-100' : 'opacity-80',
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
