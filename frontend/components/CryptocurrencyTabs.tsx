'use client'

import classNames from 'classnames'
import { Exchange } from '@/types/options'

interface CryptocurrencyTabsProps {
  selected: 'BTC' | 'ETH' | 'SOL'
  onSelect: (crypto: 'BTC' | 'ETH' | 'SOL') => void
  spotPrice: number
  exchange: Exchange
}

const CRYPTOS = ['BTC', 'ETH', 'SOL'] as const

export default function CryptocurrencyTabs({ selected, onSelect, spotPrice, exchange }: CryptocurrencyTabsProps) {
  const unit = exchange === 'okx' ? 'USD' : 'USDT'
  const unsupported = new Set<string>(exchange === 'derive' ? ['SOL'] : [])

  return (
    <div className="flex items-center gap-1 shrink-0">
      {CRYPTOS.map(crypto => {
        const isSelected = selected === crypto
        const disabled = unsupported.has(crypto)
        return (
          <button
            key={crypto}
            onClick={() => !disabled && onSelect(crypto)}
            disabled={disabled}
            className={classNames(
              'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
              disabled
                ? 'opacity-30 cursor-not-allowed text-ink-3 bg-muted border-rim'
                : isSelected
                ? 'bg-tone/10 text-tone border-tone/30'
                : 'text-ink-2 hover:text-ink bg-muted border-rim'
            )}
          >
            <span>{crypto}</span>
          </button>
        )
      })}
    </div>
  )
}
