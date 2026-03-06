'use client'

import classNames from 'classnames'

interface ExpirationTabsProps {
  expirations: string[]
  selected: string
  onSelect: (expiration: string) => void
  optionsCounts: Record<string, { calls: number; puts: number }>
}

export default function ExpirationTabs({ expirations = [], selected, onSelect, optionsCounts }: ExpirationTabsProps) {
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
        return (
          <button
            key={expiration}
            onClick={() => onSelect(expiration)}
            className={classNames(
              'flex-shrink-0 px-2.5 py-1 rounded text-[10px] font-mono font-medium transition-colors whitespace-nowrap border',
              isSelected
                ? 'bg-tone text-white border-tone'
                : 'bg-muted text-ink-2 hover:text-ink border-rim'
            )}
          >
            <div>{formatDate(expiration)}</div>
            {counts && (
              <div className={classNames('text-[9px] mt-0.5', isSelected ? 'text-white/70' : 'text-ink-3')}>
                {total}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}
