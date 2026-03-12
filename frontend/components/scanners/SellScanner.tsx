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

export default function SellScanner({ optionsData, spotPrice, coin, exchange, activeExchanges }: SellScannerProps) {
  const [optionType, setOptionType] = useState<'calls' | 'puts' | 'both'>('both')
  const [strikeInput, setStrikeInput] = useState('')
  const [sortCol, setSortCol] = useState<SortCol | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  if (!optionsData) {
    return (
      <div className="card py-6 text-center text-sm text-ink-3">
        No data available.
      </div>
    )
  }

  return <div className="card"><p className="text-ink-3 text-sm">Sell Scanner (coming soon)</p></div>
}
