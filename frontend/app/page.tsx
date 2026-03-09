'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import Header from '@/components/Header'
import CryptocurrencyTabs from '@/components/CryptocurrencyTabs'
import ExpirationTabs from '@/components/ExpirationTabs'
import OptionsChain from '@/components/OptionsChain'
import CombinedOptionsChain from '@/components/CombinedOptionsChain'
import ArbPanel from '@/components/ArbPanel'
import GammaScanner from '@/components/scanners/GammaScanner'
import VegaScanner from '@/components/scanners/VegaScanner'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'
type ExchangeKey = 'bybit' | 'okx' | 'deribit'
const ALL_EXCHANGES: ExchangeKey[] = ['bybit', 'okx', 'deribit']
import type { BoxSpread, ArbOpportunity } from '@/lib/strategies'
import { filterExpirations } from '@/lib/filterExpirations'

const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

export default function HomePage() {
  const [exchange, setExchange] = useState<Exchange>('bybit')
  const [selectedCrypto, setSelectedCrypto] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [selectedExpiration, setSelectedExpiration] = useState<string>('')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [activeExchanges, setActiveExchanges] = useState<Set<ExchangeKey>>(new Set(ALL_EXCHANGES))
  const [boxSpreads, setBoxSpreads] = useState<BoxSpread[]>([])
  const [allArbs, setAllArbs] = useState<ArbOpportunity[]>([])
  const [activeScanner, setActiveScanner] = useState<'gamma' | 'vega' | null>(null)
  const fetchVersion = useRef(0)
  const selectedExpirationRef = useRef('')

  useEffect(() => {
    fetchVersion.current++
    const version = fetchVersion.current
    const isExpiryChange = !!selectedExpirationRef.current
    if (!isExpiryChange) {
      selectedExpirationRef.current = ''
      setLoading(true)
    }

    const coin = (ex: Exchange) => ex === 'okx' ? OKX_FAMILY_MAP[selectedCrypto] : selectedCrypto
    const expiryParam = selectedExpiration ? `?expiry=${selectedExpiration}` : ''
    const evtSource = new EventSource(`http://localhost:3500/api/stream/${exchange}/${coin(exchange)}${expiryParam}`)

    evtSource.onmessage = (e) => {
      if (version !== fetchVersion.current) { evtSource.close(); return }
      try {
        const data = JSON.parse(e.data)
        if (!data || data.error || !data.data) return
        // Merge incoming expiry data into existing optionsData rather than replacing entirely.
        // Each SSE push now only contains one expiry's contracts (~30KB vs ~220KB).
        setOptionsData(prev => {
          const merged = prev ? { ...prev, data: { ...prev.data, ...data.data } } : data
          merged.spotPrice = data.spotPrice ?? merged.spotPrice
          if (data.expirations?.length) merged.expirations = data.expirations
          if (data.expirationCounts) merged.expirationCounts = data.expirationCounts
          return merged
        })
        setSpotPrice(data.spotPrice ?? 0)
        setLastUpdated(new Date())
        setLoading(false)
        if (data.expirations?.length > 0 && !selectedExpirationRef.current) {
          const first = filterExpirations(data.expirations)[0] ?? data.expirations[0]
          setSelectedExpiration(first)
          selectedExpirationRef.current = first
        }
      } catch {}
    }

    evtSource.onerror = () => {
      if (version !== fetchVersion.current) evtSource.close()
    }

    return () => evtSource.close()
  }, [selectedCrypto, exchange, selectedExpiration])

  useEffect(() => {
    if (exchange !== 'combined') return
    let cancelled = false
    const fetchArbs = () => {
      fetch(`http://localhost:3500/api/arbs/${selectedCrypto}`)
        .then(r => r.json())
        .then(d => {
          if (cancelled || !d || d.error) return
          setBoxSpreads(d.boxSpreads ?? [])
          setAllArbs(d.allArbs ?? [])
        })
        .catch(() => {})
    }
    fetchArbs()
    const id = setInterval(fetchArbs, 2000)
    return () => { cancelled = true; clearInterval(id) }
  }, [exchange, selectedCrypto])

  const handleCryptoChange = (crypto: 'BTC' | 'ETH' | 'SOL') => {
    fetchVersion.current++
    selectedExpirationRef.current = ''
    setSelectedCrypto(crypto)
    setSelectedExpiration('')
  }

  const handleExchangeChange = (ex: Exchange) => {
    fetchVersion.current++
    selectedExpirationRef.current = ''
    setExchange(ex)
    setSelectedExpiration('')
    setOptionsData(null)
    if (ex !== 'combined') {
      setBoxSpreads([])
      setAllArbs([])
    }
  }

  const expiryExchangeCounts = useMemo(() => {
    if (exchange !== 'combined' || !optionsData) return {} as Record<string, { bybit: number; okx: number; deribit: number }>
    const result: Record<string, { bybit: number; okx: number; deribit: number }> = {}
    for (const [expiry, chainData] of Object.entries(optionsData.data)) {
      const counts = { bybit: 0, okx: 0, deribit: 0 }
      const contracts = [...((chainData as any).calls ?? []), ...((chainData as any).puts ?? [])]
      for (const c of contracts) {
        if (c.prices?.bybit?.bid > 0  || c.prices?.bybit?.ask > 0)  counts.bybit++
        if (c.prices?.okx?.bid > 0    || c.prices?.okx?.ask > 0)    counts.okx++
        if (c.prices?.deribit?.bid > 0 || c.prices?.deribit?.ask > 0) counts.deribit++
      }
      result[expiry] = counts
    }
    return result
  }, [exchange, optionsData])

  const arbExpiryStrategies = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const b of boxSpreads) {
      if (!map.has(b.expiry)) map.set(b.expiry, new Set())
      map.get(b.expiry)!.add(b.type === 'long' ? 'box_long' : 'box_short')
    }
    for (const a of allArbs) {
      if (!map.has(a.expiry)) map.set(a.expiry, new Set())
      map.get(a.expiry)!.add(a.strategy)
    }
    return map
  }, [boxSpreads, allArbs])

  const boxSpreadsForExpiry = useMemo(
    () => boxSpreads.filter(b => b.expiry === selectedExpiration),
    [boxSpreads, selectedExpiration]
  )

  const arbsForExpiry = useMemo(
    () => allArbs.filter(a => a.expiry === selectedExpiration),
    [allArbs, selectedExpiration]
  )

  const chainData = selectedExpiration ? optionsData?.data?.[selectedExpiration] : undefined
  const effectiveSpotPrice = chainData?.forwardPrice || spotPrice

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={exchange} onExchangeChange={handleExchangeChange} />

      <main className="container mx-auto px-4 py-4 space-y-3">
        {/* Toolbar */}
        <div className="flex items-start gap-3 flex-wrap">
          <CryptocurrencyTabs
            selected={selectedCrypto}
            onSelect={handleCryptoChange}
            spotPrice={spotPrice}
            exchange={exchange}
          />
          {optionsData?.expirations && (
            <div className="flex-1 min-w-0">
              <ExpirationTabs
                expirations={filterExpirations(optionsData.expirations)}
                selected={selectedExpiration}
                onSelect={(exp) => { selectedExpirationRef.current = exp; setSelectedExpiration(exp) }}
                optionsCounts={optionsData.expirationCounts}
                arbExpiryStrategies={arbExpiryStrategies}
                expiryExchangeCounts={expiryExchangeCounts}
              />
            </div>
          )}
          <div className="flex-shrink-0 self-start flex gap-1">
            <button
              onClick={() => setActiveScanner(v => v === 'gamma' ? null : 'gamma')}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors',
                activeScanner === 'gamma'
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink'
              )}
            >
              Γ Scanner
            </button>
            <button
              onClick={() => setActiveScanner(v => v === 'vega' ? null : 'vega')}
              className={classNames(
                'px-2.5 py-1 rounded border text-[11px] font-medium transition-colors',
                activeScanner === 'vega'
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink'
              )}
            >
              V Scanner
            </button>
          </div>
        </div>

        {activeScanner === 'gamma' && (
          <GammaScanner
            optionsData={optionsData}
            spotPrice={spotPrice}
            coin={selectedCrypto}
            exchange={exchange}
            activeExchanges={activeExchanges}
          />
        )}
        {activeScanner === 'vega' && (
          <VegaScanner
            optionsData={optionsData}
            spotPrice={spotPrice}
            coin={selectedCrypto}
            exchange={exchange}
            activeExchanges={activeExchanges}
          />
        )}

        {/* Options chain */}
        {loading ? (
          <div className="card flex items-center justify-center h-64">
            <p className="text-ink-2 text-sm">Loading…</p>
          </div>
        ) : chainData ? (
          exchange === 'combined' ? (
            <>
              <CombinedOptionsChain
                data={chainData as any}
                spotPrice={effectiveSpotPrice}
                expiration={selectedExpiration}
                lastUpdated={lastUpdated}
                boxSpreads={boxSpreadsForExpiry}
                activeExchanges={activeExchanges}
                onToggleExchange={(ex) => setActiveExchanges(prev => {
                  const next = new Set(prev)
                  if (next.has(ex as ExchangeKey)) {
                    if (next.size === 1) return prev
                    next.delete(ex as ExchangeKey)
                  } else {
                    next.add(ex as ExchangeKey)
                  }
                  return next
                })}
              />
              {(boxSpreadsForExpiry.length > 0 || arbsForExpiry.length > 0) && (
                <ArbPanel
                  boxSpreads={boxSpreadsForExpiry}
                  arbs={arbsForExpiry}
                  expiration={selectedExpiration}
                  coin={selectedCrypto}
                  spotPrice={spotPrice}
                />
              )}
            </>
          ) : (
            <OptionsChain
              data={chainData}
              spotPrice={effectiveSpotPrice}
              expiration={selectedExpiration}
              lastUpdated={lastUpdated}
              exchange={exchange}
            />
          )
        ) : (
          <div className="card flex items-center justify-center h-64">
            <p className="text-ink-2 text-sm">
              {optionsData ? `No data for ${selectedExpiration}` : 'Select an expiration date'}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
