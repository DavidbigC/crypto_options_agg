// frontend/components/optimizer/TargetInputs.tsx
'use client'

import { OptimizerTargets, GreekTarget } from '@/types/optimizer'
import classNames from 'classnames'
import { EX_ACTIVE, EX_SOFT, EX_NAME } from '@/lib/exchangeColors'

interface TargetInputsProps {
  coin:                'BTC' | 'ETH' | 'SOL'
  targets:             OptimizerTargets
  maxCost:             number
  maxLegs:             number
  targetExpiry:        string
  exchanges:           string[]
  onExchangeChange:    (ex: string) => void
  loading:             boolean
  onCoinChange:        (c: 'BTC' | 'ETH' | 'SOL') => void
  onTargetChange:      (greek: keyof OptimizerTargets, val: GreekTarget) => void
  onMaxCostChange:     (v: number) => void
  onMaxLegsChange:     (v: number) => void
  onTargetExpiryChange:(v: string) => void
  onRun:               () => void
}

const GREEK_OPTIONS: GreekTarget[] = ['long', 'short', 'neutral', 'ignore']

const GREEK_ROWS: { key: keyof OptimizerTargets; symbol: string; label: string; description: string }[] = [
  { key: 'delta', symbol: 'Δ', label: 'Delta', description: 'Directional exposure to spot price' },
  { key: 'gamma', symbol: 'Γ', label: 'Gamma', description: 'Convexity — profit from large spot moves' },
  { key: 'vega',  symbol: 'ν', label: 'Vega',  description: 'Sensitivity to IV changes' },
  { key: 'theta', symbol: 'Θ', label: 'Theta', description: 'Time decay (short = collecting premium)' },
]

const OPTION_COLORS: Record<GreekTarget, { active: string; inactive: string }> = {
  long:    { active: 'bg-emerald-600 text-white border-emerald-600', inactive: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink' },
  short:   { active: 'bg-rose-600 text-white border-rose-600',       inactive: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink' },
  neutral: { active: 'bg-blue-600 text-white border-blue-600',       inactive: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink' },
  ignore:  { active: 'bg-ink-3 text-white border-ink-3',             inactive: 'text-ink-3 border-rim hover:border-ink-3' },
}

const COINS: ('BTC' | 'ETH' | 'SOL')[] = ['BTC', 'ETH', 'SOL']
const LEG_OPTIONS = [2, 3, 4, 5, 6]

export default function TargetInputs({
  coin, targets, maxCost, maxLegs, targetExpiry, exchanges, onExchangeChange, loading,
  onCoinChange, onTargetChange, onMaxCostChange, onMaxLegsChange, onTargetExpiryChange, onRun,
}: TargetInputsProps) {
  return (
    <div className="card space-y-4">
      <h2 className="text-sm font-semibold text-ink">Greek Optimizer</h2>

      {/* Coin */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">Coin</label>
        <div className="flex gap-1">
          {COINS.map(c => (
            <button
              key={c}
              onClick={() => onCoinChange(c)}
              className={classNames(
                'px-3 py-1 rounded text-xs font-medium transition-colors border',
                coin === c ? 'bg-card text-ink border-ink-3 shadow-sm' : 'text-ink-2 border-rim hover:border-ink-3'
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Greek targets */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-2">Greek Targets</label>
        <div className="space-y-3">
          {GREEK_ROWS.map(({ key, symbol, label, description }) => (
            <div key={key}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[12px] font-semibold text-ink w-4">{symbol}</span>
                <span className="text-[11px] text-ink-2">{label}</span>
              </div>
              <p className="text-[10px] text-ink-3 mb-1.5 ml-5">{description}</p>
              <div className="flex gap-1 ml-5">
                {GREEK_OPTIONS.map(opt => {
                  const active = targets[key] === opt
                  return (
                    <button
                      key={opt}
                      onClick={() => onTargetChange(key, opt)}
                      className={classNames(
                        'px-2 py-0.5 rounded border text-[11px] font-medium transition-colors capitalize',
                        active ? OPTION_COLORS[opt].active : OPTION_COLORS[opt].inactive
                      )}
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Max cost */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">
          Max Premium (USD)
          {maxCost === 0 && <span className="text-ink-3 ml-1">— no limit</span>}
        </label>
        <input
          type="number"
          min={0}
          step={500}
          value={maxCost || ''}
          placeholder="No limit"
          onChange={e => onMaxCostChange(parseFloat(e.target.value) || 0)}
          className="w-full px-2.5 py-1.5 text-sm rounded border border-rim bg-card text-ink focus:outline-none focus:border-ink-3"
        />
      </div>

      {/* Max legs */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">Max Legs</label>
        <div className="flex gap-1">
          {LEG_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => onMaxLegsChange(n)}
              className={classNames(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors border',
                maxLegs === n ? 'bg-card text-ink border-ink-3 shadow-sm' : 'text-ink-2 border-rim hover:border-ink-3'
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Exchanges */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">Exchanges</label>
        <div className="flex gap-1">
          {(['bybit', 'okx', 'deribit'] as const).map(ex => (
            <button
              key={ex}
              onClick={() => onExchangeChange(ex)}
              className={classNames(
                'px-2 py-1 rounded text-[11px] font-semibold transition-colors',
                exchanges.includes(ex) ? EX_ACTIVE[ex] : EX_SOFT[ex]
              )}
            >
              {EX_NAME[ex]}
            </button>
          ))}
        </div>
      </div>

      {/* Target expiry */}
      <div>
        <label className="text-[11px] text-ink-2 font-medium block mb-1.5">
          Target Expiry
          {!targetExpiry && <span className="text-ink-3 ml-1">— all expiries</span>}
        </label>
        <input
          type="date"
          value={targetExpiry}
          onChange={e => onTargetExpiryChange(e.target.value)}
          className="w-full px-2.5 py-1.5 text-sm rounded border border-rim bg-card text-ink focus:outline-none focus:border-ink-3"
        />
        {targetExpiry && (
          <button
            onClick={() => onTargetExpiryChange('')}
            className="mt-1 text-[10px] text-ink-3 hover:text-ink transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Run */}
      <button
        onClick={onRun}
        disabled={loading}
        className={classNames(
          'w-full py-2 rounded text-sm font-semibold transition-colors',
          loading
            ? 'bg-ink-3 text-white cursor-not-allowed opacity-60'
            : 'bg-tone text-white hover:opacity-90'
        )}
      >
        {loading ? 'Searching…' : 'Find Strategies'}
      </button>
    </div>
  )
}
