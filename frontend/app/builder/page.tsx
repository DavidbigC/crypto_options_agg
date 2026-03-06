'use client'

import { useState, useEffect, useRef } from 'react'
import Header from '@/components/Header'
import MiniChain from '@/components/builder/MiniChain'
import LegsPanel from '@/components/builder/LegsPanel'
import PnLChart from '@/components/builder/PnLChart'
import { Exchange, Leg, OptionsData } from '@/types/options'

const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD',
}

export default function BuilderPage() {
  const [exchange, setExchange] = useState<Exchange>('bybit')
  const [coin, setCoin] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState(0)
  const [legs, setLegs] = useState<Leg[]>([])
  const fetchVersion = useRef(0)

  const buildUrl = (ex: Exchange, c: string) =>
    ex === 'okx'      ? `/api/okx/options/${OKX_FAMILY_MAP[c]}`
    : ex === 'combined' ? `/api/combined/options/${c}`
    : ex === 'deribit'  ? `/api/deribit/options/${c}`
    : `/api/options/${c}`

  useEffect(() => {
    const version = ++fetchVersion.current
    fetch(buildUrl(exchange, coin))
      .then(r => r.json())
      .then(data => {
        if (version !== fetchVersion.current) return
        if (!data || data.error || !data.data) return
        setOptionsData(data)
        setSpotPrice(data.spotPrice ?? 0)
      })
      .catch(console.error)
  }, [exchange, coin])

  useEffect(() => {
    const id = setInterval(() => {
      fetch(buildUrl(exchange, coin))
        .then(r => r.json())
        .then(data => {
          if (!data || data.error || !data.data) return
          setOptionsData(data)
          setSpotPrice(data.spotPrice ?? 0)
        })
        .catch(() => {})
    }, 3000)
    return () => clearInterval(id)
  }, [exchange, coin])

  const addLeg = (leg: Omit<Leg, 'id'>) => {
    setLegs(prev => [...prev, { ...leg, id: crypto.randomUUID() }])
  }

  const updateLeg = (id: string, patch: Partial<Leg>) => {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  const removeLeg = (id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id))
  }

  const clearAll = () => setLegs([])

  const handleExchangeChange = (ex: Exchange) => {
    fetchVersion.current++
    setExchange(ex)
    setOptionsData(null)
  }

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={exchange} onExchangeChange={handleExchangeChange} />
      <main className="container mx-auto px-4 py-4">
        <div className="flex flex-col gap-4">
          <MiniChain
            exchange={exchange}
            coin={coin}
            onCoinChange={setCoin}
            optionsData={optionsData}
            spotPrice={spotPrice}
            onAddLeg={addLeg}
          />
          <PnLChart legs={legs} spotPrice={spotPrice} />
          <LegsPanel
            legs={legs}
            spotPrice={spotPrice}
            optionsData={optionsData}
            onUpdate={updateLeg}
            onRemove={removeLeg}
            onClearAll={clearAll}
          />
        </div>
      </main>
    </div>
  )
}
