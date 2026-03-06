'use client'

import classNames from 'classnames'
import { Leg, OptionsData } from '@/types/options'

interface LegsPanelProps {
  legs: Leg[]
  spotPrice: number
  optionsData: OptionsData | null
  onUpdate: (id: string, patch: Partial<Leg>) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}

export default function LegsPanel({ legs, spotPrice, optionsData, onUpdate, onRemove, onClearAll }: LegsPanelProps) {
  const getLivePrice = (leg: Leg): number => {
    if (!optionsData) return 0
    const chain = optionsData.data[leg.expiry]
    if (!chain) return 0
    const arr = leg.type === 'call' ? chain.calls : chain.puts
    const contract = arr.find(c => c.strike === leg.strike)
    return contract?.markPrice ?? 0
  }

  const totalCost = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? -1 : 1
    return sum + sign * l.entryPrice * l.qty
  }, 0)

  const totalValue = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? 1 : -1
    return sum + sign * getLivePrice(l) * l.qty * l.contractSize
  }, 0)

  const totalPnl = totalCost + totalValue

  if (legs.length === 0) {
    return (
      <div className="card text-center py-8 text-sm text-ink-3">
        Click bid/ask in the chain to add legs
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">Position Legs</h2>
        <button onClick={onClearAll} className="text-xs text-ink-3 hover:text-red-500 transition-colors">
          Clear all
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-rim text-ink-2 text-[11px]">
              <th className="py-1 w-6" />
              <th className="py-1 text-left">Side</th>
              <th className="py-1 text-left">Expiry</th>
              <th className="py-1 text-right">Strike</th>
              <th className="py-1 text-center">C/P</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Entry</th>
              <th className="py-1 text-right">Mark</th>
              <th className="py-1 text-right">P&L</th>
              <th className="py-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => {
              const markPrice = getLivePrice(leg)
              const sign = leg.side === 'buy' ? 1 : -1
              const pnl = sign * (markPrice * leg.contractSize - leg.entryPrice) * leg.qty
              return (
                <tr key={leg.id} className={classNames('border-b border-rim', { 'opacity-40': !leg.enabled })}>
                  <td className="py-1">
                    <input type="checkbox" checked={leg.enabled}
                      onChange={e => onUpdate(leg.id, { enabled: e.target.checked })}
                      className="rounded" />
                  </td>
                  <td className="py-1">
                    <button
                      onClick={() => onUpdate(leg.id, { side: leg.side === 'buy' ? 'sell' : 'buy' })}
                      className={classNames('px-1.5 py-0.5 rounded text-[10px] font-semibold', {
                        'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400': leg.side === 'buy',
                        'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400': leg.side === 'sell',
                      })}>
                      {leg.side.toUpperCase()}
                    </button>
                  </td>
                  <td className="py-1 text-ink-2 font-mono">
                    {new Date(leg.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="py-1 text-right font-mono text-ink">{leg.strike.toLocaleString()}</td>
                  <td className="py-1 text-center">
                    <span className={classNames('px-1 rounded text-[10px]', {
                      'text-green-700 dark:text-green-400': leg.type === 'call',
                      'text-red-600 dark:text-red-400': leg.type === 'put',
                    })}>
                      {leg.type === 'call' ? 'C' : 'P'}
                    </span>
                  </td>
                  <td className="py-1 text-right">
                    <input type="number" min={1} value={leg.qty}
                      onChange={e => onUpdate(leg.id, { qty: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-12 text-right border border-rim rounded px-1 py-0.5 text-xs bg-card text-ink" />
                  </td>
                  <td className="py-1 text-right">
                    <input type="number" step={0.01} value={leg.entryPrice}
                      onChange={e => onUpdate(leg.id, { entryPrice: parseFloat(e.target.value) || 0 })}
                      className="w-20 text-right border border-rim rounded px-1 py-0.5 text-xs bg-card text-ink" />
                  </td>
                  <td className="py-1 text-right font-mono text-ink-2">
                    {markPrice > 0 ? markPrice.toFixed(0) : '--'}
                  </td>
                  <td className={classNames('py-1 text-right font-mono font-semibold', {
                    'text-green-700 dark:text-green-400': pnl >= 0,
                    'text-red-600 dark:text-red-400': pnl < 0,
                  })}>
                    {markPrice > 0 ? (pnl >= 0 ? '+' : '') + pnl.toFixed(0) : '--'}
                  </td>
                  <td className="py-1">
                    <button onClick={() => onRemove(leg.id)}
                      className="text-ink-3 hover:text-red-500 text-base leading-none px-1">×</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-rim font-semibold text-xs">
              <td colSpan={8} className="pt-2 text-ink-2">Total</td>
              <td className={classNames('pt-2 text-right font-mono', {
                'text-green-700 dark:text-green-400': totalPnl >= 0,
                'text-red-600 dark:text-red-400': totalPnl < 0,
              })}>
                {(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(0)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
