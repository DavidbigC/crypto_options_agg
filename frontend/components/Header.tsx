'use client'

import classNames from 'classnames'
import { Sun, Moon } from 'lucide-react'
import { Exchange } from '@/types/options'
import { useTheme } from '@/components/ThemeProvider'
import { getHeaderLinks } from '@/lib/publicRuntime.js'

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
  { id: 'binance',  label: 'Binance' },
  { id: 'combined', label: 'Combined' },
]

export default function Header({ exchange, onExchangeChange, hideExchangeSelector = false }: HeaderProps) {
  const { theme, toggle } = useTheme()
  const headerLinks = getHeaderLinks()

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

          {headerLinks.map(({ href, label }) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="text-xs text-ink-2 hover:text-ink transition-colors">
              {label}
            </a>
          ))}

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
