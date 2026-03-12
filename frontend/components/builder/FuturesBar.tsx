'use client'

import { useEffect, useState } from 'react'
import classNames from 'classnames'
import { EX_ACTIVE, EX_NAME } from '@/lib/exchangeColors'
import { apiPath } from '@/lib/apiBase.js'

interface FuturesContract {
  symbol: string
  exchange: string
  expiry: string | null
  isPerp: boolean
  markPrice: number
  bid: number
  ask: number
}

interface FuturesBarProps {
  coin: string
  onAdd: (side: 'buy' | 'sell', entryPrice: number, expiry: string, exchange: string) => void
  allowedExchanges?: string[]
  defaultExchange?: string
}

export default function FuturesBar({
  coin,
  onAdd,
  allowedExchanges,
  defaultExchange,
}: FuturesBarProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('sell')
  const [contracts, setContracts] = useState<FuturesContract[]>([])
  const [selectedEx, setSelectedEx] = useState<string>(defaultExchange ?? 'bybit')
  const [selected, setSelected] = useState<string>('')
  const [customPrice, setCustomPrice] = useState('')

  useEffect(() => {
    fetch(apiPath(`futures/${coin}`))
      .then((r) => r.json())
      .then((d) => {
        const all: FuturesContract[] = d.futures ?? []
        const filtered = allowedExchanges?.length
          ? all.filter((contract) => allowedExchanges.includes(contract.exchange))
          : all
        const list = filtered.filter((contract) => contract.symbol.toUpperCase().includes(coin.toUpperCase()))
        setContracts(list)
        const preferred = list.find((contract) => contract.isPerp && contract.exchange === (defaultExchange ?? 'bybit'))
          ?? list.find((contract) => contract.isPerp)
          ?? list[0]
        setSelected(preferred?.symbol ?? '')
        setSelectedEx(preferred?.exchange ?? defaultExchange ?? 'bybit')
      })
      .catch(() => {})
  }, [allowedExchanges, coin, defaultExchange])

  const contract = contracts.find((item) => item.symbol === selected)
  const mark = contract?.markPrice ?? 0
  const price = customPrice ? parseFloat(customPrice) : mark

  const exchanges = Array.from(new Set(contracts.map((contract) => contract.exchange)))
  const exContracts = contracts.filter((contract) => contract.exchange === selectedEx)
  const exPerps = exContracts.filter((contract) => contract.isPerp)
  const exDated = exContracts.filter((contract) => !contract.isPerp)

  function selectChip(symbol: string) {
    setSelected(symbol)
    setCustomPrice('')
  }

  function handleAdd() {
    if (!contract || !price || price <= 0) return
    const expiry = contract.isPerp ? 'perpetual' : (contract.expiry ?? 'perpetual')
    onAdd(side, price, expiry, contract.exchange)
    setCustomPrice('')
  }

  return (
    <div className="card py-2.5 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-ink-2">Futures / Perp</span>

        <div className="flex rounded overflow-hidden border border-rim text-[11px]">
          {(['buy', 'sell'] as const).map((value) => (
            <button
              key={value}
              onClick={() => setSide(value)}
              className={classNames('px-2.5 py-1 font-semibold', {
                'bg-green-600 text-white': value === 'buy' && side === value,
                'bg-red-600 text-white': value === 'sell' && side === value,
                'text-ink-2 hover:bg-muted': side !== value,
              })}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex rounded overflow-hidden border border-rim text-[11px]">
          {exchanges.map((exchange) => (
            <button
              key={exchange}
              onClick={() => {
                setSelectedEx(exchange)
                const first = contracts.find((contractItem) => contractItem.exchange === exchange && contractItem.isPerp)
                  ?? contracts.find((contractItem) => contractItem.exchange === exchange)
                if (first) selectChip(first.symbol)
              }}
              className={classNames('px-2.5 py-1 font-semibold transition-colors', {
                [EX_ACTIVE[exchange] ?? 'bg-zinc-500 text-white']: selectedEx === exchange,
                'text-ink-2 hover:bg-muted': selectedEx !== exchange,
              })}
            >
              {EX_NAME[exchange] ?? exchange}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          Entry
          <input
            type="number"
            value={customPrice}
            onChange={(event) => setCustomPrice(event.target.value)}
            placeholder={mark > 0 ? mark.toFixed(0) : 'mark'}
            className="w-24 border border-rim rounded px-2 py-1 text-xs bg-card text-ink font-mono"
          />
        </label>

        <button
          onClick={handleAdd}
          className="px-3 py-1 bg-tone text-white rounded text-xs font-medium hover:opacity-90"
        >
          + Add
        </button>

        <span className="text-[10px] text-ink-3">delta = ±1 · no θ/ν</span>
      </div>

      {exContracts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {exPerps.map((item) => (
            <button
              key={item.symbol}
              onClick={() => selectChip(item.symbol)}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors font-mono',
                selected === item.symbol
                  ? (EX_ACTIVE[item.exchange] ?? 'bg-zinc-500 text-white') + ' border-transparent'
                  : 'border-rim text-ink-2 hover:border-ink-3 hover:text-ink',
              )}
            >
              Perp · {item.markPrice > 0 ? item.markPrice.toFixed(0) : '--'}
            </button>
          ))}

          {exPerps.length > 0 && exDated.length > 0 && (
            <div className="w-px bg-rim self-stretch" />
          )}

          {exDated.map((item) => (
            <button
              key={item.symbol}
              onClick={() => selectChip(item.symbol)}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors font-mono',
                selected === item.symbol
                  ? (EX_ACTIVE[item.exchange] ?? 'bg-zinc-500 text-white') + ' border-transparent'
                  : 'border-rim text-ink-2 hover:border-ink-3 hover:text-ink',
              )}
            >
              {item.expiry ? new Date(item.expiry).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : item.symbol}
              {' · '}
              {item.markPrice > 0 ? item.markPrice.toFixed(0) : '--'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
