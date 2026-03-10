// frontend/components/optimizer/ResultCard.tsx
'use client'

import { OptimizerResult, OptimizerTargets } from '@/types/optimizer'
import GreekBar from './GreekBar'
import classNames from 'classnames'

interface ResultCardProps {
  result:    OptimizerResult
  targets:   OptimizerTargets
  rank:      number
  coin:      string
  spotPrice: number
}

const SIDE_COLOR: Record<string, string> = {
  buy:  'text-emerald-600 dark:text-emerald-400',
  sell: 'text-rose-600 dark:text-rose-400',
}

const TYPE_LABEL: Record<string, string> = {
  call:   'Call',
  put:    'Put',
  future: 'Perp/Fut',
}

const EX_BADGE_CLS: Record<string, string> = {
  bybit:   'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  okx:     'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  deribit: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
}

function fmtUSD(v: number): string {
  return Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(2)}k` : `$${v.toFixed(0)}`
}

function fmtExpiry(exp: string): string {
  if (exp === 'perpetual') return 'Perp'
  const d = new Date(exp + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export default function ResultCard({ result, targets, rank, coin, spotPrice }: ResultCardProps) {
  const { name, legs, netGreeks, totalCost, score, rebalancingNote } = result

  const handleLoadInBuilder = () => {
    localStorage.setItem('optimizer_import', JSON.stringify({
      coin,
      spotPrice,
      legs: legs.map((l, i) => ({
        id: `opt-${i}`,
        exchange: l.exchange ?? 'bybit',
        coin,
        symbol: l.type === 'future'
          ? `${coin}-PERP`
          : `${coin}-${l.expiry}-${l.strike}-${l.type.toUpperCase()[0]}`,
        expiry: l.expiry,
        strike: l.strike,
        type: l.type,
        side: l.side,
        qty: l.qty,
        entryPrice: l.price,
        markVol: 0,
        contractSize: 1,
        enabled: true,
      })),
    }))
    window.open('/builder', '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="card space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium text-ink-3 w-5">#{rank}</span>
          <span className="text-sm font-semibold text-ink">{name}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-ink-2">Score <span className="text-ink font-medium">{score.toFixed(1)}</span></span>
          <span className={classNames('font-medium', totalCost >= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
            {totalCost >= 0 ? `Cost ${fmtUSD(totalCost)}` : `Credit ${fmtUSD(-totalCost)}`}
          </span>
        </div>
      </div>

      {/* Legs table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-rim text-ink-3">
              <th className="text-left py-1 pr-3 font-medium">Side</th>
              <th className="text-left py-1 pr-3 font-medium">Type</th>
              <th className="text-right py-1 pr-3 font-medium">Strike</th>
              <th className="text-left py-1 pr-3 font-medium">Expiry</th>
              <th className="text-left py-1 pr-3 font-medium">Exchange</th>
              <th className="text-right py-1 pr-3 font-medium">Price</th>
              <th className="text-right py-1 font-medium">Qty</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={i} className="border-b border-rim/50 last:border-0">
                <td className={classNames('py-1 pr-3 font-medium capitalize', SIDE_COLOR[leg.side])}>
                  {leg.side}
                </td>
                <td className="py-1 pr-3 text-ink">{TYPE_LABEL[leg.type] ?? leg.type}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-ink">
                  {leg.type === 'future' ? '—' : leg.strike.toLocaleString()}
                </td>
                <td className="py-1 pr-3 text-ink">{fmtExpiry(leg.expiry)}</td>
                <td className="py-1 pr-3">
                  {leg.exchange && (
                    <span className={classNames('px-1.5 py-0.5 rounded text-[10px] font-medium', EX_BADGE_CLS[leg.exchange] ?? 'bg-muted text-ink-2')}>
                      {leg.exchange.charAt(0).toUpperCase()}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-ink">
                  {leg.type === 'future' ? '—' : fmtUSD(leg.price)}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {leg.qty.toFixed(leg.type === 'future' ? 3 : 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Greek bars */}
      <div className="space-y-1.5 py-1 border-t border-rim">
        <GreekBar label="Δ" value={netGreeks.delta} target={targets.delta} formatValue={v => v.toFixed(3)} />
        <GreekBar label="Γ" value={netGreeks.gamma} target={targets.gamma} formatValue={v => v.toFixed(5)} />
        <GreekBar label="ν" value={netGreeks.vega}  target={targets.vega}  formatValue={v => `$${v.toFixed(0)}`} />
        <GreekBar label="Θ" value={netGreeks.theta} target={targets.theta} formatValue={v => `$${v.toFixed(0)}`} />
      </div>

      {/* Rebalancing note */}
      {rebalancingNote && rebalancingNote !== 'No special rebalancing required.' && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded p-2 border border-amber-200 dark:border-amber-800">
          ⚠ {rebalancingNote}
        </div>
      )}

      {/* Load in Builder */}
      <div className="flex justify-end pt-1">
        <button
          onClick={handleLoadInBuilder}
          className="px-3 py-1 text-[11px] font-medium rounded border border-rim text-ink-2 hover:text-ink hover:border-ink-3 transition-colors"
        >
          Load in Builder →
        </button>
      </div>
    </div>
  )
}
