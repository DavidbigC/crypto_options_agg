// frontend/components/optimizer/GreekBar.tsx
import { GreekTarget } from '@/types/optimizer'
import classNames from 'classnames'

interface GreekBarProps {
  label:  string
  value:  number
  target: GreekTarget
  formatValue?: (v: number) => string
}

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (Math.abs(v) >= 1)    return v.toFixed(2)
  return v.toFixed(4)
}

export default function GreekBar({ label, value, target, formatValue = defaultFormat }: GreekBarProps) {
  const sign = value > 0 ? 'long' : value < 0 ? 'short' : 'neutral'

  const targetMet =
    (target === 'long'    && value > 0) ||
    (target === 'short'   && value < 0) ||
    (target === 'neutral' && Math.abs(value) < 0.05) ||
    target === 'ignore'

  const barWidth = Math.min(100, Math.abs(value) > 0
    ? Math.min(100, (Math.log10(Math.abs(value) + 1) / 3) * 100)
    : 0
  )

  const barColor = sign === 'long'
    ? 'bg-emerald-500'
    : sign === 'short'
    ? 'bg-rose-500'
    : 'bg-ink-3'

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-4 text-ink-2 font-medium shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={classNames('h-full rounded-full transition-all', barColor)}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <span className={classNames('w-20 text-right tabular-nums', {
        'text-emerald-600 dark:text-emerald-400': sign === 'long',
        'text-rose-600 dark:text-rose-400': sign === 'short',
        'text-ink-3': sign === 'neutral',
      })}>
        {value > 0 ? '+' : ''}{formatValue(value)}
      </span>
      <span className={classNames('w-20 text-[10px]', targetMet ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500')}>
        {target === 'ignore' ? '—' : targetMet ? `✓ ${target}` : `✗ ${target}`}
      </span>
    </div>
  )
}
