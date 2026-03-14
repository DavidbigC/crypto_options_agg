'use client'

import classNames from 'classnames'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
  const pathname = usePathname()
  const headerLinks = getHeaderLinks()

  return (
    <header className="border-b border-rim/80 bg-card/85 backdrop-blur-sm">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.24em] text-ink-3">Institutional research workspace</div>
              <Link href="/" className="heading-serif mt-1 inline-block text-2xl font-semibold text-ink hover:text-tone">
                Volatility Desk
              </Link>
              <p className="mt-1 max-w-xl text-sm text-ink-2">
                Cross-venue crypto options research across live chains, scanners, and structure analysis.
              </p>
            </div>

            <div className="flex items-center gap-2 self-start">
              <nav className="surface-well flex flex-wrap items-center gap-1 px-1.5 py-1">
                {headerLinks.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className={classNames(
                      'rounded-full px-3 py-1.5 text-xs font-medium',
                      pathname === href
                        ? 'bg-card text-ink shadow-sm ring-1 ring-rim'
                        : 'text-ink-2 hover:text-ink',
                    )}
                  >
                    {label}
                  </Link>
                ))}
              </nav>

              <button
                onClick={toggle}
                className="surface-well p-2 text-ink-2 hover:text-ink"
                aria-label="Toggle dark mode"
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
          </div>

          {!hideExchangeSelector && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rim/75 pt-3">
              <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">Venue scope</div>
              <div className="surface-well flex flex-wrap items-center gap-1 p-1">
                {EXCHANGES.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => onExchangeChange(id)}
                    className={classNames(
                      'rounded-full px-3 py-1.5 text-xs font-medium',
                      exchange === id
                        ? 'bg-card text-ink shadow-sm ring-1 ring-rim'
                        : 'text-ink-2 hover:bg-card/70 hover:text-ink'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
