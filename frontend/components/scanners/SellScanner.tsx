'use client'

import { useMemo, useState } from 'react'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'

interface SellScannerProps {
  optionsData: OptionsData | null
  spotPrice: number
  coin: 'BTC' | 'ETH' | 'SOL'
  exchange: Exchange
  activeExchanges?: Set<string>
}

interface SellRow {
  expiry: string
  dte: number
  optionType: 'call' | 'put'
  strike: number
  bid: number
  apr: number
  iv: number       // markVol * 100 (percent)
  ivApr: number    // iv / apr
  delta: number
}

type SortCol = 'expiry' | 'dte' | 'optionType' | 'strike' | 'bid' | 'apr' | 'iv' | 'ivApr' | 'delta'

function getBestBid(contract: any, activeExchanges?: Set<string>): number {
  if (activeExchanges && contract.prices) {
    let best = 0
    for (const ex of Array.from(activeExchanges)) {
      const bid = contract.prices[ex]?.bid
      if (bid && bid > 0 && (best === 0 || bid > best)) best = bid
    }
    if (best > 0) return best
  }
  return (contract.bestBid ?? contract.bid) || 0
}

export default function SellScanner({ optionsData, spotPrice, coin, exchange, activeExchanges }: SellScannerProps) {
  const [optionType, setOptionType] = useState<'calls' | 'puts' | 'both'>('both')
  const [strikeInput, setStrikeInput] = useState('')
  const [sortCol, setSortCol] = useState<SortCol | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const targetStrike = strikeInput ? parseFloat(strikeInput) : null

  const rows = useMemo<SellRow[]>(() => {
    if (!optionsData) return []

    const result: SellRow[] = []
    const now = Date.now()

    for (const expiry of optionsData.expirations) {
      const chain = optionsData.data[expiry]
      if (!chain) continue
      const expiryTs = new Date(expiry + 'T08:00:00Z').getTime()
      const dte = (expiryTs - now) / 86_400_000
      if (dte < 0.5) continue

      const processContracts = (contracts: any[], type: 'call' | 'put') => {
        if (optionType === 'calls' && type === 'put') return
        if (optionType === 'puts' && type === 'call') return

        const otm = contracts.filter(c =>
          type === 'call' ? c.strike > spotPrice : c.strike < spotPrice
        )
        if (!otm.length) return

        let contract: any
        if (targetStrike) {
          contract = otm.reduce((best, c) =>
            Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best
          )
        } else {
          contract = otm.reduce((best, c) =>
            Math.abs(c.strike - spotPrice) < Math.abs(best.strike - spotPrice) ? c : best
          )
        }

        const bid = getBestBid(contract, activeExchanges)
        if (!bid || bid <= 0) return
        if (!contract.markVol) return

        const collateral = type === 'call' ? spotPrice : contract.strike
        const apr = (bid / collateral) * (365 / dte) * 100
        const iv = contract.markVol ? contract.markVol * 100 : 0
        const ivApr = apr > 0 && iv > 0 ? iv / apr : 0
        const delta = Math.abs(contract.delta ?? 0)

        result.push({ expiry, dte, optionType: type, strike: contract.strike, bid, apr, iv, ivApr, delta })
      }

      processContracts(chain.calls, 'call')
      processContracts(chain.puts, 'put')
    }

    return result.sort((a, b) => {
      if (sortCol) {
        let diff: number
        if (sortCol === 'expiry') diff = a.expiry.localeCompare(b.expiry)
        else if (sortCol === 'optionType') diff = a.optionType.localeCompare(b.optionType)
        else diff = (a[sortCol] as number) - (b[sortCol] as number)
        return sortDir === 'desc' ? -diff : diff
      }
      return b.apr - a.apr
    })
  }, [optionsData, spotPrice, optionType, targetStrike, activeExchanges, sortCol, sortDir])

  if (!optionsData) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        No data available.
      </div>
    )
  }

  if (!spotPrice || spotPrice <= 0) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        Waiting for spot price…
      </div>
    )
  }

  return <div className="card"><p className="text-ink-3 text-sm">Sell Scanner (coming soon)</p></div>
}
