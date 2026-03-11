'use client'

import classNames from 'classnames'
import { Sun, Moon } from 'lucide-react'
import { Exchange } from '@/types/options'
import { useTheme } from '@/components/ThemeProvider'

interface HeaderProps {
  exchange: Exchange
  onExchangeChange: (exchange: Exchange) => void
  hideExchangeSelector?: boolean
}

const EXCHANGES: { id: Exchange; label: string }[] = [
  { id: 'bybit',    label: 'Bybit' },
  { id: 'okx',      label: 'OKX' },
  { id: 'deribit',  label: 'Deribit' },
  { id: 'derive',   label: 'Derive' },
  { id: 'combined', label: 'Combined' },
]

export default function Header({ exchange, onExchangeChange, hideExchangeSelector = false }: HeaderProps) {
  const { theme, toggle } = useTheme()

  return (
    <header className="bg-card border-b border-rim">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center gap-4">
          <a href="/" target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-ink tracking-tight shrink-0 hover:text-tone transition-colors">Options</a>

          {!hideExchangeSelector && (
            <div className="flex items-center bg-muted rounded-md p-0.5 gap-0.5">
              {EXCHANGES.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => onExchangeChange(id)}
                  className={classNames(
                    'px-3 py-1 rounded text-xs font-medium transition-colors',
                    exchange === id
                      ? 'bg-card text-ink shadow-sm'
                      : 'text-ink-2 hover:text-ink'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1" />

          <a href="/analysis" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
            Analysis
          </a>
          <a href="/optimizer" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
            Optimizer
          </a>
          <a href="/builder" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
            Strategy Builder
          </a>
          <a href="/portfolio" target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
            Portfolio
          </a>

          <button
            onClick={toggle}
            className="p-1.5 rounded-md text-ink-2 hover:text-ink hover:bg-muted transition-colors"
            aria-label="Toggle dark mode"
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>
    </header>
  )
}
