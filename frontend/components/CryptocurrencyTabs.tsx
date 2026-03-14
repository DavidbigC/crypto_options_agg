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
    <div className="surface-well flex items-center gap-1 p-1 shrink-0">
      {CRYPTOS.map(crypto => {
        const isSelected = selected === crypto
        const disabled = unsupported.has(crypto)
        return (
          <button
            key={crypto}
            onClick={() => !disabled && onSelect(crypto)}
            disabled={disabled}
            className={classNames(
              'min-w-[5.5rem] rounded-[0.8rem] px-3 py-2 text-left transition-colors',
              disabled
                ? 'cursor-not-allowed text-ink-3 opacity-35'
                : isSelected
                  ? 'bg-card text-ink shadow-sm ring-1 ring-rim'
                  : 'text-ink-2 hover:bg-card/70 hover:text-ink'
            )}
          >
            <div className="text-sm font-semibold">{crypto}</div>
            <div className="mt-0.5 text-[11px] text-ink-3">
              {isSelected && spotPrice > 0
                ? `${Math.round(spotPrice).toLocaleString()} ${unit}`
                : disabled
                  ? 'Unavailable'
                  : 'Research'}
            </div>
          </button>
        )
      })}
    </div>
  )
}
