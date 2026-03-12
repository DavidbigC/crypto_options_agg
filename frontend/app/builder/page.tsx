'use client'

import { useState, useEffect, useRef } from 'react'
import classNames from 'classnames'
import Header from '@/components/Header'
import MiniChain from '@/components/builder/MiniChain'
import LegsPanel from '@/components/builder/LegsPanel'
import PnLChart from '@/components/builder/PnLChart'
import { Exchange, Leg, OptionsData, CONTRACT_SIZES } from '@/types/options'
import { impliedVol } from '@/lib/blackScholes'
import { EX_BADGE, EX_ACTIVE, EX_NAME } from '@/lib/exchangeColors'
import { apiPath } from '@/lib/apiBase.js'

// ── Futures leg adder ────────────────────────────────────────────────────────

interface FuturesContract {
  symbol: string
  exchange: string
  expiry: string | null
  isPerp: boolean
  markPrice: number
  bid: number
  ask: number
}


function FuturesBar({ coin, spotPrice, onAdd }: {
  coin: string
  spotPrice: number
  onAdd: (side: 'buy' | 'sell', entryPrice: number, expiry: string, exchange: string) => void
}) {
  const [side, setSide]               = useState<'buy' | 'sell'>('sell')
  const [contracts, setContracts]     = useState<FuturesContract[]>([])
  const [selectedEx, setSelectedEx]   = useState<string>('bybit')
  const [selected, setSelected]       = useState<string>('')
  const [customPrice, setCustomPrice] = useState('')

  useEffect(() => {
    fetch(apiPath(`futures/${coin}`))
      .then(r => r.json())
      .then(d => {
        const all: FuturesContract[] = d.futures ?? []
        const list = all.filter(c => c.symbol.toUpperCase().includes(coin.toUpperCase()))
        setContracts(list)
        // default: bybit perp
        const perp = list.find(c => c.isPerp && c.exchange === 'bybit')
          ?? list.find(c => c.isPerp)
        setSelected(perp?.symbol ?? list[0]?.symbol ?? '')
        if (perp) setSelectedEx(perp.exchange)
      })
      .catch(() => {})
  }, [coin])

  const contract = contracts.find(c => c.symbol === selected)
  const mark     = contract?.markPrice ?? 0
  const price    = customPrice ? parseFloat(customPrice) : mark

  const handleAdd = () => {
    if (!contract || !price || price <= 0) return
    const expiry = contract.isPerp ? 'perpetual' : (contract.expiry ?? 'perpetual')
    onAdd(side, price, expiry, contract.exchange)
    setCustomPrice('')
  }

  // All exchanges present in data
  const exchanges = Array.from(new Set(contracts.map(c => c.exchange)))

  // Contracts filtered to selected exchange
  const exContracts = contracts.filter(c => c.exchange === selectedEx)
  const exPerps  = exContracts.filter(c => c.isPerp)
  const exDated  = exContracts.filter(c => !c.isPerp)

  const fmtExpiry = (c: FuturesContract) =>
    c.isPerp ? 'Perp' : (c.expiry ? new Date(c.expiry).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : c.symbol)

  const selectChip = (sym: string) => { setSelected(sym); setCustomPrice('') }

  return (
    <div className="card py-2.5 space-y-2">
      {/* Row 1: controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-ink-2">Futures / Perp</span>

        {/* Side */}
        <div className="flex rounded overflow-hidden border border-rim text-[11px]">
          {(['buy', 'sell'] as const).map(s => (
            <button key={s} onClick={() => setSide(s)}
              className={classNames('px-2.5 py-1 font-semibold', {
                'bg-green-600 text-white': s === 'buy'  && side === s,
                'bg-red-600   text-white': s === 'sell' && side === s,
                'text-ink-2 hover:bg-muted': side !== s,
              })}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Exchange tabs */}
        <div className="flex rounded overflow-hidden border border-rim text-[11px]">
          {exchanges.map(ex => (
            <button key={ex} onClick={() => {
              setSelectedEx(ex)
              const first = contracts.find(c => c.exchange === ex && c.isPerp)
                ?? contracts.find(c => c.exchange === ex)
              if (first) selectChip(first.symbol)
            }}
              className={classNames('px-2.5 py-1 font-semibold transition-colors', {
                [EX_ACTIVE[ex] ?? 'bg-zinc-500 text-white']: selectedEx === ex,
                'text-ink-2 hover:bg-muted': selectedEx !== ex,
              })}>
              {EX_NAME[ex] ?? ex}
            </button>
          ))}
        </div>

        {/* Entry price */}
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          Entry
          <input type="number" value={customPrice}
            onChange={e => setCustomPrice(e.target.value)}
            placeholder={mark > 0 ? mark.toFixed(0) : 'mark'}
            className="w-24 border border-rim rounded px-2 py-1 text-xs bg-card text-ink font-mono"
          />
        </label>

        <button onClick={handleAdd}
          className="px-3 py-1 bg-tone text-white rounded text-xs font-medium hover:opacity-90">
          + Add
        </button>

        <span className="text-[10px] text-ink-3">delta = ±1 · no θ/ν</span>
      </div>

      {/* Row 2: contract chips for selected exchange */}
      {exContracts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {/* Perps */}
          {exPerps.map(c => (
            <button key={c.symbol} onClick={() => selectChip(c.symbol)}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors font-mono',
                selected === c.symbol
                  ? (EX_ACTIVE[c.exchange] ?? 'bg-zinc-500 text-white') + ' border-transparent'
                  : 'border-rim text-ink-2 hover:border-ink-3 hover:text-ink'
              )}>
              Perp · {c.markPrice > 0 ? c.markPrice.toFixed(0) : '--'}
            </button>
          ))}

          {exPerps.length > 0 && exDated.length > 0 && (
            <div className="w-px bg-rim self-stretch" />
          )}

          {/* Dated */}
          {exDated.map(c => (
            <button key={c.symbol} onClick={() => selectChip(c.symbol)}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors font-mono',
                selected === c.symbol
                  ? (EX_ACTIVE[c.exchange] ?? 'bg-zinc-500 text-white') + ' border-transparent'
                  : 'border-rim text-ink-2 hover:border-ink-3 hover:text-ink'
              )}>
              {fmtExpiry(c)} · {c.markPrice > 0 ? c.markPrice.toFixed(0) : '--'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

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

  // Import legs from optimizer if available
  useEffect(() => {
    try {
      const raw = localStorage.getItem('optimizer_import')
      if (!raw) return
      localStorage.removeItem('optimizer_import')
      const imported = JSON.parse(raw)
      if (imported?.legs?.length) {
        setLegs(imported.legs)
        if (imported.coin) setCoin(imported.coin)
      }
    } catch {}
  }, [])

  const buildUrl = (ex: Exchange, c: string) =>
    ex === 'okx'      ? apiPath(`okx/options/${OKX_FAMILY_MAP[c]}`)
    : ex === 'combined' ? apiPath(`combined/options/${c}`)
    : ex === 'deribit'  ? apiPath(`deribit/options/${c}`)
    : apiPath(`bybit/snapshot/${c}`)

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
      const version = fetchVersion.current
      fetch(buildUrl(exchange, coin))
        .then(r => r.json())
        .then(data => {
          if (version !== fetchVersion.current) return
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

  // Import strategy from ArbPanel "→ Builder" click
  useEffect(() => {
    const raw = localStorage.getItem('arb_pending_strategy')
    if (!raw) return
    localStorage.removeItem('arb_pending_strategy')
    try {
      const { coin: pendingCoin, legs: pendingLegs } = JSON.parse(raw)
      setCoin(pendingCoin)
      setExchange('combined')
      for (const l of pendingLegs) {
        const ex = (l.exchange ?? 'bybit') as Exchange
        if (l.type === 'future') {
          addLeg({
            exchange: ex,
            coin: pendingCoin,
            symbol: '',
            expiry: l.expiry,
            strike: 0,
            type: 'future',
            side: l.action,
            qty: l.qty,
            entryPrice: l.price,
            markVol: 0,
            contractSize: 1,
            enabled: true,
          })
        } else {
          // Arb scanner prices come from the combined view (already USD-normalized),
          // so contractSize is always 1 regardless of the per-leg exchange.
          const daysToExpiry = Math.max(1, (new Date(l.expiry).getTime() - Date.now()) / 86_400_000)
          const T = daysToExpiry / 365
          // Back-calculate IV from the actual entry price so the chart baseline is accurate.
          const vol = spotPrice > 0
            ? impliedVol(spotPrice, l.strike, T, l.price, l.type)
            : 0.5
          addLeg({
            exchange: ex,
            coin: pendingCoin,
            symbol: '',
            expiry: l.expiry,
            strike: l.strike,
            type: l.type,
            side: l.action,
            qty: l.qty,
            entryPrice: l.price,
            markVol: vol,
            contractSize: 1,
            enabled: true,
          })
        }
      }
    } catch {}
  }, [])

  const updateLeg = (id: string, patch: Partial<Leg>) => {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l))
  }

  const removeLeg = (id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id))
  }

  const clearAll = () => setLegs([])

  const addFutureLeg = (side: 'buy' | 'sell', entryPrice: number, expiry: string, exchange = 'bybit') => {
    addLeg({
      exchange: exchange as Exchange,
      coin,
      symbol: '',
      expiry,
      strike: 0,
      type: 'future',
      side,
      qty: 1,
      entryPrice,
      markVol: 0,
      contractSize: 1,
      enabled: true,
    })
  }

  const handleExchangeChange = (ex: Exchange) => {
    fetchVersion.current++
    setExchange(ex)
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
          <FuturesBar coin={coin} spotPrice={spotPrice} onAdd={addFutureLeg} />
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
