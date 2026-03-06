# Position Builder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/builder` page where users browse a live mini options chain, add multi-leg positions, and simulate P&L across price and time using Black-Scholes.

**Architecture:** Client-side Black-Scholes engine reprices all legs at any (spot, date, IV) combo. Builder state (legs array) lives in the page component. Mini chain fetches from existing backend endpoints. Recharts renders the P&L chart.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, Tailwind CSS, Recharts (already installed), classnames.

---

## Task 1: Black-Scholes Library

**Files:**
- Create: `frontend/lib/blackScholes.ts`

**Step 1: Create the file with normCDF, normPDF, bsPrice, bsGreeks**

```ts
// frontend/lib/blackScholes.ts

function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
}

export function bsPrice(
  S: number, K: number, T: number, sigma: number, r: number,
  type: 'call' | 'put'
): number {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S)
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  if (type === 'call') {
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
  }
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1)
}

export interface Greeks {
  delta: number
  gamma: number
  theta: number  // USD/day
  vega: number   // USD per 1% IV
}

export function bsGreeks(
  S: number, K: number, T: number, sigma: number, r: number,
  type: 'call' | 'put'
): Greeks {
  if (T <= 0) {
    return { delta: type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 }
  }
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const nd1 = normPDF(d1)
  const delta = type === 'call' ? normCDF(d1) : normCDF(d1) - 1
  const gamma = nd1 / (S * sigma * sqrtT)
  const theta = type === 'call'
    ? (-S * nd1 * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-S * nd1 * sigma / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365
  const vega = S * nd1 * sqrtT / 100
  return { delta, gamma, theta, vega }
}

/** Find zero-crossings (breakevens) in a pnl array paired with prices */
export function findBreakevens(prices: number[], pnls: number[]): number[] {
  const result: number[] = []
  for (let i = 1; i < pnls.length; i++) {
    if ((pnls[i - 1] < 0 && pnls[i] >= 0) || (pnls[i - 1] >= 0 && pnls[i] < 0)) {
      const t = -pnls[i - 1] / (pnls[i] - pnls[i - 1])
      result.push(prices[i - 1] + t * (prices[i] - prices[i - 1]))
    }
  }
  return result
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -20`
Expected: no errors relating to blackScholes.ts

---

## Task 2: Builder Types

**Files:**
- Modify: `frontend/types/options.ts`

**Step 1: Add Leg interface and CONTRACT_SIZES constant at the bottom of options.ts**

```ts
// Add to frontend/types/options.ts

export const CONTRACT_SIZES: Record<string, Record<string, number>> = {
  bybit: { BTC: 1, ETH: 1, SOL: 1 },
  okx:   { BTC: 0.1, ETH: 1, SOL: 1 },
  combined: { BTC: 1, ETH: 1, SOL: 1 },
}

export interface Leg {
  id: string
  exchange: Exchange
  coin: string             // 'BTC' | 'ETH' | 'SOL'
  symbol: string
  expiry: string           // 'YYYY-MM-DD'
  strike: number
  type: 'call' | 'put'
  side: 'buy' | 'sell'
  qty: number
  entryPrice: number       // USD
  markVol: number          // IV decimal e.g. 0.54
  contractSize: number
  enabled: boolean
}
```

**Step 2: Verify no TypeScript errors**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -20`

---

## Task 3: Builder Page Skeleton

**Files:**
- Create: `frontend/app/builder/page.tsx`
- Create: `frontend/components/builder/.gitkeep` (mkdir placeholder)

**Step 1: Create the builder components directory**

```bash
mkdir -p "/Users/davidc/Scripts/binance options/frontend/components/builder"
```

**Step 2: Create the page with state and two-column layout**

```tsx
// frontend/app/builder/page.tsx
'use client'

import { useState, useEffect, useRef } from 'react'
import Header from '@/components/Header'
import MiniChain from '@/components/builder/MiniChain'
import LegsPanel from '@/components/builder/LegsPanel'
import PnLChart from '@/components/builder/PnLChart'
import { Exchange, Leg, OptionsData, CONTRACT_SIZES } from '@/types/options'

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

  useEffect(() => {
    const version = ++fetchVersion.current
    const url = exchange === 'okx'
      ? `/api/okx/options/${OKX_FAMILY_MAP[coin]}`
      : `/api/options/${coin}`
    fetch(url)
      .then(r => r.json())
      .then(data => {
        if (version !== fetchVersion.current) return
        if (!data || data.error || !data.data) return
        setOptionsData(data)
        setSpotPrice(data.spotPrice ?? 0)
      })
      .catch(console.error)
  }, [exchange, coin])

  // Refresh spot + mark prices every 3s (no legs state reset)
  useEffect(() => {
    const id = setInterval(() => {
      const url = exchange === 'okx'
        ? `/api/okx/options/${OKX_FAMILY_MAP[coin]}`
        : `/api/options/${coin}`
      fetch(url)
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

  const handleExchangeChange = (ex: Exchange) => {
    fetchVersion.current++
    setExchange(ex)
    setOptionsData(null)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header exchange={exchange} onExchangeChange={handleExchangeChange} />
      <main className="container mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* Left: mini chain picker */}
          <div className="w-[38%] flex-shrink-0">
            <MiniChain
              exchange={exchange}
              coin={coin}
              onCoinChange={setCoin}
              optionsData={optionsData}
              spotPrice={spotPrice}
              onAddLeg={addLeg}
            />
          </div>
          {/* Right: legs + chart */}
          <div className="flex-1 flex flex-col gap-4">
            <LegsPanel
              legs={legs}
              spotPrice={spotPrice}
              optionsData={optionsData}
              onUpdate={updateLeg}
              onRemove={removeLeg}
            />
            <PnLChart
              legs={legs}
              spotPrice={spotPrice}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
```

**Step 3: Verify page loads (stub components will be created next)**

---

## Task 4: MiniChain Component

**Files:**
- Create: `frontend/components/builder/MiniChain.tsx`

**Step 1: Create the component**

```tsx
// frontend/components/builder/MiniChain.tsx
'use client'

import { useState } from 'react'
import classNames from 'classnames'
import { Exchange, Leg, OptionsData, OptionContract, CONTRACT_SIZES } from '@/types/options'

interface MiniChainProps {
  exchange: Exchange
  coin: string
  onCoinChange: (coin: 'BTC' | 'ETH' | 'SOL') => void
  optionsData: OptionsData | null
  spotPrice: number
  onAddLeg: (leg: Omit<Leg, 'id'>) => void
}

const COINS = ['BTC', 'ETH', 'SOL'] as const

export default function MiniChain({ exchange, coin, onCoinChange, optionsData, spotPrice, onAddLeg }: MiniChainProps) {
  const [selectedExpiry, setSelectedExpiry] = useState<string>('')

  const expirations = optionsData?.expirations ?? []
  const expiry = selectedExpiry || expirations[0] || ''
  const chainData = optionsData?.data[expiry]

  const allStrikes = Array.from(new Set([
    ...(chainData?.calls.map(c => c.strike) ?? []),
    ...(chainData?.puts.map(p => p.strike) ?? []),
  ])).sort((a, b) => a - b)

  const callsMap = new Map(chainData?.calls.map(c => [c.strike, c]) ?? [])
  const putsMap  = new Map(chainData?.puts.map(p => [p.strike, p]) ?? [])

  const atmStrike = allStrikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev, allStrikes[0] ?? 0)

  const makeLeg = (contract: OptionContract, side: 'buy' | 'sell', type: 'call' | 'put'): Omit<Leg, 'id'> => ({
    exchange,
    coin,
    symbol: contract.symbol,
    expiry,
    strike: contract.strike,
    type,
    side,
    qty: 1,
    entryPrice: side === 'buy' ? contract.ask : contract.bid,
    markVol: contract.markVol ?? contract.impliedVolatility ?? 0.5,
    contractSize: CONTRACT_SIZES[exchange]?.[coin] ?? 1,
    enabled: true,
  })

  const fmtPrice = (v: number) => v > 0 ? v.toFixed(0) : '--'

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Options Chain</h2>
        {/* Coin tabs */}
        <div className="flex gap-1">
          {COINS.map(c => (
            <button key={c} onClick={() => onCoinChange(c)}
              className={classNames('px-2 py-0.5 rounded text-xs font-medium', {
                'bg-blue-600 text-white': coin === c,
                'text-gray-500 hover:text-gray-700': coin !== c,
              })}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Expiry selector */}
      <div className="flex flex-wrap gap-1">
        {expirations.slice(0, 8).map(exp => (
          <button key={exp} onClick={() => setSelectedExpiry(exp)}
            className={classNames('px-2 py-0.5 rounded text-[10px] font-mono border', {
              'bg-blue-600 text-white border-blue-600': expiry === exp,
              'text-gray-500 border-gray-200 hover:border-gray-400': expiry !== exp,
            })}>
            {new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </button>
        ))}
      </div>

      {/* Chain table */}
      {!chainData ? (
        <div className="text-xs text-gray-400 text-center py-8">Loading...</div>
      ) : (
        <div className="overflow-y-auto max-h-[calc(100vh-280px)]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-1 text-right pr-1 font-medium">Bid</th>
                <th className="py-1 text-right pr-2 font-medium">Ask</th>
                <th className="py-1 text-center font-semibold text-gray-700">Strike</th>
                <th className="py-1 text-left pl-2 font-medium">Bid</th>
                <th className="py-1 text-left font-medium">Ask</th>
              </tr>
              <tr className="border-b border-gray-100 text-[9px] text-gray-400">
                <th colSpan={2} className="text-center pb-0.5 text-green-600">CALLS</th>
                <th></th>
                <th colSpan={2} className="text-center pb-0.5 text-red-500">PUTS</th>
              </tr>
            </thead>
            <tbody>
              {allStrikes.map(strike => {
                const call = callsMap.get(strike)
                const put  = putsMap.get(strike)
                const isATM = strike === atmStrike
                return (
                  <tr key={strike} className={classNames('border-b border-gray-50 hover:bg-gray-50', {
                    'bg-blue-50': isATM,
                  })}>
                    <td className="py-0.5 pr-1 text-right">
                      {call?.bid ? (
                        <button onClick={() => call && onAddLeg(makeLeg(call, 'sell', 'call'))}
                          className="text-green-700 hover:bg-green-100 px-1 rounded cursor-pointer">
                          {fmtPrice(call.bid)}
                        </button>
                      ) : '--'}
                    </td>
                    <td className="py-0.5 pr-2 text-right">
                      {call?.ask ? (
                        <button onClick={() => call && onAddLeg(makeLeg(call, 'buy', 'call'))}
                          className="text-green-700 hover:bg-green-100 px-1 rounded cursor-pointer font-medium">
                          {fmtPrice(call.ask)}
                        </button>
                      ) : '--'}
                    </td>
                    <td className={classNames('py-0.5 text-center font-mono font-semibold text-[11px]', {
                      'text-blue-600': isATM, 'text-gray-700': !isATM,
                    })}>
                      {strike.toLocaleString()}
                    </td>
                    <td className="py-0.5 pl-2 text-left">
                      {put?.bid ? (
                        <button onClick={() => put && onAddLeg(makeLeg(put, 'sell', 'put'))}
                          className="text-red-600 hover:bg-red-50 px-1 rounded cursor-pointer">
                          {fmtPrice(put.bid)}
                        </button>
                      ) : '--'}
                    </td>
                    <td className="py-0.5 text-left">
                      {put?.ask ? (
                        <button onClick={() => put && onAddLeg(makeLeg(put, 'buy', 'put'))}
                          className="text-red-600 hover:bg-red-50 px-1 rounded cursor-pointer font-medium">
                          {fmtPrice(put.ask)}
                        </button>
                      ) : '--'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-gray-400">Click Ask to buy · Click Bid to sell</p>
    </div>
  )
}
```

**Step 2: Verify tsc**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -30`

---

## Task 5: LegsPanel Component

**Files:**
- Create: `frontend/components/builder/LegsPanel.tsx`

**Step 1: Create the component**

```tsx
// frontend/components/builder/LegsPanel.tsx
'use client'

import classNames from 'classnames'
import { Leg, OptionsData } from '@/types/options'

interface LegsPanelProps {
  legs: Leg[]
  spotPrice: number
  optionsData: OptionsData | null
  onUpdate: (id: string, patch: Partial<Leg>) => void
  onRemove: (id: string) => void
}

export default function LegsPanel({ legs, spotPrice, optionsData, onUpdate, onRemove }: LegsPanelProps) {
  // Get live mark price for a leg from optionsData
  const getLivePrice = (leg: Leg): number => {
    if (!optionsData) return 0
    const chain = optionsData.data[leg.expiry]
    if (!chain) return 0
    const arr = leg.type === 'call' ? chain.calls : chain.puts
    const contract = arr.find(c => c.strike === leg.strike)
    return contract?.markPrice ?? 0
  }

  const totalCost = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? -1 : 1
    return sum + sign * l.entryPrice * l.qty * l.contractSize
  }, 0)

  const totalValue = legs.filter(l => l.enabled).reduce((sum, l) => {
    const sign = l.side === 'buy' ? 1 : -1
    return sum + sign * getLivePrice(l) * l.qty * l.contractSize
  }, 0)

  const totalPnl = totalCost + totalValue

  if (legs.length === 0) {
    return (
      <div className="card text-center py-8 text-sm text-gray-400">
        Click bid/ask in the chain to add legs
      </div>
    )
  }

  return (
    <div className="card">
      <h2 className="text-sm font-semibold mb-3">Position Legs</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500 text-[11px]">
              <th className="py-1 w-6"></th>
              <th className="py-1 text-left">Side</th>
              <th className="py-1 text-left">Expiry</th>
              <th className="py-1 text-right">Strike</th>
              <th className="py-1 text-center">C/P</th>
              <th className="py-1 text-right">Qty</th>
              <th className="py-1 text-right">Entry</th>
              <th className="py-1 text-right">Mark</th>
              <th className="py-1 text-right">P&L</th>
              <th className="py-1 w-6"></th>
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => {
              const markPrice = getLivePrice(leg)
              const sign = leg.side === 'buy' ? 1 : -1
              const pnl = sign * (markPrice - leg.entryPrice) * leg.qty * leg.contractSize
              return (
                <tr key={leg.id} className={classNames('border-b border-gray-50', {
                  'opacity-40': !leg.enabled,
                })}>
                  <td className="py-1">
                    <input type="checkbox" checked={leg.enabled}
                      onChange={e => onUpdate(leg.id, { enabled: e.target.checked })}
                      className="rounded" />
                  </td>
                  <td className="py-1">
                    <button
                      onClick={() => onUpdate(leg.id, { side: leg.side === 'buy' ? 'sell' : 'buy' })}
                      className={classNames('px-1.5 py-0.5 rounded text-[10px] font-semibold', {
                        'bg-green-100 text-green-700': leg.side === 'buy',
                        'bg-red-100 text-red-700': leg.side === 'sell',
                      })}>
                      {leg.side.toUpperCase()}
                    </button>
                  </td>
                  <td className="py-1 text-gray-600 font-mono">
                    {new Date(leg.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="py-1 text-right font-mono">{leg.strike.toLocaleString()}</td>
                  <td className="py-1 text-center">
                    <span className={classNames('px-1 rounded text-[10px]', {
                      'text-green-700': leg.type === 'call',
                      'text-red-600': leg.type === 'put',
                    })}>
                      {leg.type === 'call' ? 'C' : 'P'}
                    </span>
                  </td>
                  <td className="py-1 text-right">
                    <input type="number" min={1} value={leg.qty}
                      onChange={e => onUpdate(leg.id, { qty: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-12 text-right border border-gray-200 rounded px-1 py-0.5 text-xs" />
                  </td>
                  <td className="py-1 text-right">
                    <input type="number" step={0.01} value={leg.entryPrice}
                      onChange={e => onUpdate(leg.id, { entryPrice: parseFloat(e.target.value) || 0 })}
                      className="w-20 text-right border border-gray-200 rounded px-1 py-0.5 text-xs" />
                  </td>
                  <td className="py-1 text-right font-mono">
                    {markPrice > 0 ? markPrice.toFixed(0) : '--'}
                  </td>
                  <td className={classNames('py-1 text-right font-mono font-semibold', {
                    'text-green-600': pnl >= 0,
                    'text-red-500': pnl < 0,
                  })}>
                    {markPrice > 0 ? (pnl >= 0 ? '+' : '') + pnl.toFixed(0) : '--'}
                  </td>
                  <td className="py-1">
                    <button onClick={() => onRemove(leg.id)}
                      className="text-gray-300 hover:text-red-400 text-base leading-none px-1">×</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 font-semibold text-xs">
              <td colSpan={8} className="pt-2 text-gray-600">Total</td>
              <td className={classNames('pt-2 text-right font-mono', {
                'text-green-600': totalPnl >= 0,
                'text-red-500': totalPnl < 0,
              })}>
                {(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(0)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
```

**Step 2: Verify tsc**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -30`

---

## Task 6: PnLChart Component

**Files:**
- Create: `frontend/components/builder/PnLChart.tsx`

**Step 1: Create the component**

```tsx
// frontend/components/builder/PnLChart.tsx
'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend
} from 'recharts'
import { Leg } from '@/types/options'
import { bsPrice, bsGreeks, findBreakevens, Greeks } from '@/lib/blackScholes'

interface PnLChartProps {
  legs: Leg[]
  spotPrice: number
}

const PRICE_POINTS = 120

function computePnL(legs: Leg[], prices: number[], sliderDays: number, ivMult: number): number[] {
  return prices.map(S => {
    return legs.filter(l => l.enabled).reduce((sum, leg) => {
      const expiryMs = new Date(leg.expiry).getTime()
      const daysToExpiry = Math.max(0, (expiryMs - Date.now()) / 86_400_000)
      const T = Math.max(0, (daysToExpiry - sliderDays) / 365)
      const sigma = Math.max(0.001, leg.markVol * ivMult)
      const value = bsPrice(S, leg.strike, T, sigma, 0, leg.type) * leg.qty * leg.contractSize
      const cost  = leg.entryPrice * leg.qty * leg.contractSize
      const sign  = leg.side === 'buy' ? 1 : -1
      return sum + sign * (value - cost)
    }, 0)
  })
}

function computePositionGreeks(legs: Leg[], spot: number, sliderDays: number, ivMult: number): Greeks {
  return legs.filter(l => l.enabled).reduce((acc, leg) => {
    const expiryMs = new Date(leg.expiry).getTime()
    const daysToExpiry = Math.max(0, (expiryMs - Date.now()) / 86_400_000)
    const T = Math.max(0, (daysToExpiry - sliderDays) / 365)
    const sigma = Math.max(0.001, leg.markVol * ivMult)
    const g = bsGreeks(spot, leg.strike, T, sigma, 0, leg.type)
    const scale = leg.qty * leg.contractSize * (leg.side === 'buy' ? 1 : -1)
    return {
      delta: acc.delta + g.delta * scale,
      gamma: acc.gamma + g.gamma * scale,
      theta: acc.theta + g.theta * scale,
      vega:  acc.vega  + g.vega  * scale,
    }
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 })
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded shadow-sm px-3 py-2 text-xs">
      <div className="font-mono text-gray-700 mb-1">${Number(label).toLocaleString()}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-semibold">{p.value >= 0 ? '+' : ''}{p.value.toFixed(0)} USD</span>
        </div>
      ))}
    </div>
  )
}

export default function PnLChart({ legs, spotPrice }: PnLChartProps) {
  const [sliderDays, setSliderDays] = useState(0)
  const [ivStress, setIvStress] = useState(0)  // percent: -80 to 300

  const activeLegExpiries = legs.filter(l => l.enabled).map(l => l.expiry)
  const maxDays = activeLegExpiries.length > 0
    ? Math.max(0, Math.min(...activeLegExpiries.map(exp =>
        Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000)
      )))
    : 30

  const ivMult = 1 + ivStress / 100

  const prices = useMemo(() => {
    if (!spotPrice) return []
    const lo = spotPrice * 0.7
    const hi = spotPrice * 1.3
    return Array.from({ length: PRICE_POINTS }, (_, i) => lo + (hi - lo) * i / (PRICE_POINTS - 1))
  }, [spotPrice])

  const todayPnL    = useMemo(() => computePnL(legs, prices, 0, ivMult), [legs, prices, ivMult])
  const sliderPnL   = useMemo(() => computePnL(legs, prices, sliderDays, ivMult), [legs, prices, sliderDays, ivMult])
  const greeks      = useMemo(() => computePositionGreeks(legs, spotPrice, sliderDays, ivMult), [legs, spotPrice, sliderDays, ivMult])
  const breakevens  = useMemo(() => findBreakevens(prices, todayPnL), [prices, todayPnL])

  const chartData = prices.map((p, i) => ({
    price: Math.round(p),
    today: parseFloat(todayPnL[i].toFixed(2)),
    selected: parseFloat(sliderPnL[i].toFixed(2)),
  }))

  const sliderDate = new Date(Date.now() + sliderDays * 86_400_000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (legs.length === 0) {
    return (
      <div className="card text-center py-12 text-sm text-gray-400">
        Add legs to see P&L simulation
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">P&L Simulation</h2>
        <div className="flex items-center gap-6 text-xs text-gray-500">
          {/* Date slider */}
          <label className="flex items-center gap-2">
            <span className="w-8">Date</span>
            <input type="range" min={0} max={maxDays} value={sliderDays}
              onChange={e => setSliderDays(Number(e.target.value))}
              className="w-32 accent-orange-500" />
            <span className="w-20 text-orange-500 font-mono">
              {sliderDays === 0 ? 'Today' : sliderDate}
            </span>
          </label>
          {/* IV stress slider */}
          <label className="flex items-center gap-2">
            <span className="w-4">IV</span>
            <input type="range" min={-80} max={300} value={ivStress}
              onChange={e => setIvStress(Number(e.target.value))}
              className="w-28 accent-orange-500" />
            <span className="w-14 font-mono text-orange-500">
              {ivStress >= 0 ? '+' : ''}{ivStress}%
            </span>
          </label>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="price" tickFormatter={v => `$${(v/1000).toFixed(0)}k`}
            tick={{ fontSize: 10 }} />
          <YAxis tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`}
            tick={{ fontSize: 10 }} width={55} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="#e5e7eb" strokeDasharray="4 4" />
          <ReferenceLine x={Math.round(spotPrice)} stroke="#94a3b8" strokeDasharray="3 3"
            label={{ value: 'Spot', position: 'top', fontSize: 9, fill: '#94a3b8' }} />
          {breakevens.map((be, i) => (
            <ReferenceLine key={i} x={Math.round(be)} stroke="#f59e0b" strokeDasharray="2 2"
              label={{ value: `BE $${Math.round(be).toLocaleString()}`, position: 'insideTopLeft', fontSize: 9, fill: '#f59e0b' }} />
          ))}
          <Line type="monotone" dataKey="today" name="Today" stroke="#22c55e"
            dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="selected" name={sliderDays === 0 ? 'Today' : sliderDate}
            stroke="#f97316" dot={false} strokeWidth={2} strokeDasharray="5 3" />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </LineChart>
      </ResponsiveContainer>

      {/* Greeks bar */}
      <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-4 gap-2 text-xs text-center">
        {[
          { label: 'Delta', value: greeks.delta, dp: 3 },
          { label: 'Gamma', value: greeks.gamma, dp: 5 },
          { label: 'Theta', value: greeks.theta, dp: 1 },
          { label: 'Vega',  value: greeks.vega,  dp: 1 },
        ].map(g => (
          <div key={g.label} className="bg-gray-50 rounded p-2">
            <div className="text-gray-500">{g.label}</div>
            <div className={`font-mono font-semibold ${g.value >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {g.value >= 0 ? '+' : ''}{g.value.toFixed(g.dp)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Verify tsc**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -30`

---

## Task 7: Add Builder Link to Header

**Files:**
- Modify: `frontend/components/Header.tsx`

**Step 1: Add the Builder nav link**

In `Header.tsx`, find the `<nav>` element and add a link to `/builder`:

```tsx
<nav className="flex items-center space-x-6">
  <a href="/builder" className="text-gray-600 hover:text-gray-900">Builder</a>
  <a href="#" className="text-gray-600 hover:text-gray-900">Markets</a>
  <a href="#" className="text-gray-600 hover:text-gray-900">Trading</a>
  <a href="#" className="text-gray-600 hover:text-gray-900">Portfolio</a>
</nav>
```

**Step 2: Verify tsc + check browser**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1 | head -20`

---

## Task 8: Final Check

**Step 1: Full tsc pass**

Run: `cd "/Users/davidc/Scripts/binance options/frontend" && npx tsc --noEmit 2>&1`
Expected: no errors

**Step 2: Smoke test in browser**
1. Navigate to `http://localhost:3000/builder`
2. Chain loads with BTC data
3. Click an ask cell → leg appears in LegsPanel
4. Chart renders with green line
5. Move date slider → dashed orange line shifts
6. Move IV slider → both curves update
7. Greeks bar updates
