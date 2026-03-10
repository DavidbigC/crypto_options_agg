'use client'

import classNames from 'classnames'
import { BoxSpread } from '@/lib/strategies'
import { EX_BADGE, EX_LABEL } from '@/lib/exchangeColors'

interface BoxSpreadsPanelProps {
  boxSpreads: BoxSpread[]
  expiration: string
}

export default function BoxSpreadsPanel({ boxSpreads, expiration }: BoxSpreadsPanelProps) {
  if (boxSpreads.length === 0) return null

  const sorted = [...boxSpreads].sort((a, b) => b.profit - a.profit)

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-ink mb-3">
        Box Spread Opportunities
        <span className="ml-2 text-xs font-normal text-ink-3">
          {new Date(expiration).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {sorted.length} found · fees included
        </span>
      </h2>

      <div className="space-y-2">
        {sorted.map((b, i) => (
          <div key={i} className="border border-rim rounded p-3 text-xs">
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">
                  {b.type === 'long' ? 'Long Box' : 'Short Box'}
                </span>
                <span className="text-ink-3 font-mono">
                  {b.k1.toLocaleString()} / {b.k2.toLocaleString()}
                </span>
                <span className="text-ink-3">
                  box ${b.boxValue.toLocaleString()} · {Math.ceil((new Date(b.expiry).getTime() - Date.now()) / 86_400_000)}d
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className={classNames('font-mono font-bold', {
                  'text-green-600 dark:text-green-400': b.profit > 0,
                })}>
                  +${b.profit.toFixed(0)}
                </span>
                {(() => {
                  const days = Math.max(1, (new Date(b.expiry).getTime() - Date.now()) / 86_400_000)
                  const collateral = b.type === 'long' ? b.cost : b.boxValue
                  const apr = collateral > 0 ? (b.profit / collateral) * (365 / days) * 100 : 0
                  return (
                    <span className="text-amber-600 dark:text-amber-400 font-mono font-semibold">
                      {apr.toFixed(1)}% APR
                    </span>
                  )
                })()}
              </div>
            </div>

            {/* Legs */}
            <div className="grid grid-cols-2 gap-1.5">
              {b.legs.map((leg, j) => (
                <div key={j} className="flex items-center gap-1.5 bg-muted rounded px-2 py-1">
                  <span className={classNames('w-7 text-center rounded text-[10px] font-bold px-0.5', {
                    'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400': leg.action === 'buy',
                    'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400': leg.action === 'sell',
                  })}>
                    {leg.action === 'buy' ? 'BUY' : 'SELL'}
                  </span>
                  <span className={classNames('text-[10px] font-semibold w-4', {
                    'text-green-700 dark:text-green-400': leg.type === 'call',
                    'text-red-600 dark:text-red-400': leg.type === 'put',
                  })}>
                    {leg.type === 'call' ? 'C' : 'P'}
                  </span>
                  <span className="font-mono text-ink">{leg.strike.toLocaleString()}</span>
                  <span className="font-mono text-ink-2 ml-auto">${leg.price.toFixed(0)}</span>
                  {leg.exchange && (
                    <span className={classNames('text-[9px] text-white rounded px-0.5 font-bold', EX_BADGE[leg.exchange] ?? 'bg-zinc-500')}>
                      {EX_LABEL[leg.exchange] ?? leg.exchange}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Summary */}
            <div className="mt-2 text-ink-3 flex gap-4">
              <span>
                {b.type === 'long'
                  ? `Cost $${b.cost.toFixed(0)} · collect $${b.boxValue.toLocaleString()} at expiry`
                  : `Receive $${b.cost.toFixed(0)} · pay $${b.boxValue.toLocaleString()} at expiry`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
