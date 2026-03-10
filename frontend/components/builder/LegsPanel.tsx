'use client'

import classNames from 'classnames'
import { Leg, OptionsData } from '@/types/options'
import { bsGreeks } from '@/lib/blackScholes'
import { EX_SOFT, EX_LABEL } from '@/lib/exchangeColors'

interface LegsPanelProps {
  legs: Leg[]
  spotPrice: number
  optionsData: OptionsData | null
  onUpdate: (id: string, patch: Partial<Leg>) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}

export default function LegsPanel({ legs, spotPrice, optionsData, onUpdate, onRemove, onClearAll }: LegsPanelProps) {
  const getLegGreeks = (leg: Leg) => {
    const scale = leg.qty * leg.contractSize * (leg.side === 'buy' ? 1 : -1)
    if (leg.type === 'future') {
      return { delta: scale, gamma: 0, theta: 0, vega: 0 }
    }
    const daysToExpiry = Math.max(0, (new Date(leg.expiry).getTime() - Date.now()) / 86_400_000)
    const T = Math.max(0, daysToExpiry / 365)
    const sigma = Math.max(0.001, leg.markVol)
    const g = bsGreeks(spotPrice, leg.strike, T, sigma, 0, leg.type)
    return {
      delta: g.delta * scale,
      gamma: g.gamma * scale,
      theta: g.theta * scale,
      vega:  g.vega  * scale,
    }
  }

  const netGreeks = legs.filter(l => l.enabled).reduce((acc, leg) => {
    const g = getLegGreeks(leg)
    return { delta: acc.delta + g.delta, gamma: acc.gamma + g.gamma, theta: acc.theta + g.theta, vega: acc.vega + g.vega }
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 })

  const getLivePrice = (leg: Leg): number => {
    if (leg.type === 'future') return spotPrice   // futures mark = current spot
    if (!optionsData) return 0
    const chain = optionsData.data[leg.expiry]
    if (!chain) return 0
    const arr = leg.type === 'call' ? chain.calls : chain.puts
    const contract = arr.find(c => c.strike === leg.strike)
    return contract?.markPrice ?? 0
  }

  const totalCost = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? -1 : 1
    return sum + sign * l.entryPrice * l.contractSize * l.qty
  }, 0)

  const totalValue = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? 1 : -1
    return sum + sign * getLivePrice(l) * l.qty * l.contractSize
  }, 0)

  const totalPnl = totalCost + totalValue
  const allMarksLoaded = legs.filter(l => l.enabled).every(l => getLivePrice(l) > 0)

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
              <th className="py-1 text-left">Ex</th>
              <th className="py-1 text-left">Expiry</th>
              <th className="py-1 text-right">Strike</th>
              <th className="py-1 text-center">C/P</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Entry</th>
              <th className="py-1 text-right">Mark</th>
              <th className="py-1 text-right">P&L</th>
              <th className="py-1 text-right text-ink-3">Δ</th>
              <th className="py-1 text-right text-ink-3">Γ</th>
              <th className="py-1 text-right text-ink-3">Θ</th>
              <th className="py-1 text-right text-ink-3">V</th>
              <th className="py-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => {
              const markPrice = getLivePrice(leg)
              const sign = leg.side === 'buy' ? 1 : -1
              const pnl = sign * (markPrice - leg.entryPrice) * leg.contractSize * leg.qty
              const lg = getLegGreeks(leg)
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
                  <td className="py-1">
                    <span className={classNames('text-[9px] px-1 py-0.5 rounded font-bold', EX_SOFT[leg.exchange] ?? 'bg-zinc-500/20 text-zinc-500')}>
                      {EX_LABEL[leg.exchange] ?? leg.exchange.slice(0,3).toUpperCase()}
                    </span>
                  </td>
                  <td className="py-1 text-ink-2 font-mono">
                    {leg.expiry === 'perpetual'
                      ? 'Perp'
                      : new Date(leg.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="py-1 text-right font-mono text-ink">
                    {leg.type === 'future' ? '--' : leg.strike.toLocaleString()}
                  </td>
                  <td className="py-1 text-center">
                    <span className={classNames('px-1 rounded text-[10px] font-semibold', {
                      'text-green-700 dark:text-green-400': leg.type === 'call',
                      'text-red-600 dark:text-red-400':     leg.type === 'put',
                      'text-amber-600 dark:text-amber-400': leg.type === 'future',
                    })}>
                      {leg.type === 'call' ? 'C' : leg.type === 'put' ? 'P' : 'FUT'}
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
                  <td className="py-1 text-right font-mono text-ink-3 text-[11px]">{lg.delta.toFixed(2)}</td>
                  <td className="py-1 text-right font-mono text-ink-3 text-[11px]">{lg.gamma.toFixed(4)}</td>
                  <td className="py-1 text-right font-mono text-ink-3 text-[11px]">{lg.theta.toFixed(1)}</td>
                  <td className="py-1 text-right font-mono text-ink-3 text-[11px]">{lg.vega.toFixed(1)}</td>
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
              <td colSpan={9} className="pt-2 text-ink-2">Total</td>
              <td className={classNames('pt-2 text-right font-mono', {
                'text-green-700 dark:text-green-400': allMarksLoaded && totalPnl >= 0,
                'text-red-600 dark:text-red-400': allMarksLoaded && totalPnl < 0,
                'text-ink-3': !allMarksLoaded,
              })}>
                {allMarksLoaded ? (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(0) : '--'}
              </td>
              <td className="pt-2 text-right font-mono text-[11px] text-ink-2">{netGreeks.delta.toFixed(2)}</td>
              <td className="pt-2 text-right font-mono text-[11px] text-ink-2">{netGreeks.gamma.toFixed(4)}</td>
              <td className="pt-2 text-right font-mono text-[11px] text-ink-2">{netGreeks.theta.toFixed(1)}</td>
              <td className="pt-2 text-right font-mono text-[11px] text-ink-2">{netGreeks.vega.toFixed(1)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
