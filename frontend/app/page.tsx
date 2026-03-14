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
import SellScanner from '@/components/scanners/SellScanner'
import classNames from 'classnames'
import { OptionsData, Exchange } from '@/types/options'
import { apiPath, ssePath } from '@/lib/apiBase.js'
import { SCANNER_META, SCANNER_ORDER } from '@/lib/scannerMetadata.mjs'
type ExchangeKey = 'bybit' | 'okx' | 'deribit' | 'derive' | 'binance'
type ScannerKey = 'gamma' | 'vega' | 'sell'
const ALL_EXCHANGES: ExchangeKey[] = ['bybit', 'okx', 'deribit', 'derive', 'binance']
import type { BoxSpread, ArbOpportunity } from '@/lib/strategies'
import { filterExpirations } from '@/lib/filterExpirations'

const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

function buildOptionsUrl(exchange: Exchange, coin: 'BTC' | 'ETH' | 'SOL') {
  return exchange === 'okx'
    ? apiPath(`okx/options/${OKX_FAMILY_MAP[coin]}`)
    : exchange === 'combined'
      ? apiPath(`combined/options/${coin}`)
      : exchange === 'deribit'
        ? apiPath(`deribit/options/${coin}`)
        : exchange === 'derive'
          ? apiPath(`derive/options/${coin}`)
          : exchange === 'binance'
            ? apiPath(`binance/options/${coin}`)
            : apiPath(`bybit/snapshot/${coin}`)
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
  const [activeScanner, setActiveScanner] = useState<ScannerKey | null>(null)
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
    const evtSource = new EventSource(ssePath(`stream/${exchange}/${coin(exchange)}${expiryParam}`))
    const loadingTimeout = !isExpiryChange
      ? setTimeout(() => {
          if (version === fetchVersion.current) setLoading(false)
        }, 4000)
      : null

    if (!isExpiryChange) {
      fetch(buildOptionsUrl(exchange, selectedCrypto))
        .then(r => r.json())
        .then(data => {
          if (version !== fetchVersion.current) return
          if (!data || data.error || !data.data) return
          setOptionsData(data)
          setSpotPrice(data.spotPrice ?? 0)
          setLastUpdated(new Date())
          setLoading(false)
          if (data.expirations?.length > 0 && !selectedExpirationRef.current) {
            const first = filterExpirations(data.expirations)[0] ?? data.expirations[0]
            setSelectedExpiration(first)
            selectedExpirationRef.current = first
          }
        })
        .catch(() => {
          if (version === fetchVersion.current) setLoading(false)
        })
    }

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
        if (loadingTimeout) clearTimeout(loadingTimeout)
        if (data.expirations?.length > 0 && !selectedExpirationRef.current) {
          const first = filterExpirations(data.expirations)[0] ?? data.expirations[0]
          setSelectedExpiration(first)
          selectedExpirationRef.current = first
        }
      } catch {}
    }

    evtSource.onerror = () => {
      if (version === fetchVersion.current) setLoading(false)
      if (loadingTimeout) clearTimeout(loadingTimeout)
      if (version !== fetchVersion.current) evtSource.close()
    }

    return () => {
      if (loadingTimeout) clearTimeout(loadingTimeout)
      evtSource.close()
    }
  }, [selectedCrypto, exchange, selectedExpiration])

  useEffect(() => {
    if (exchange !== 'combined') return
    let cancelled = false
    const fetchArbs = () => {
      fetch(apiPath(`arbs/${selectedCrypto}`))
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
    if (exchange !== 'combined' || !optionsData) return {} as Record<string, { bybit: number; okx: number; deribit: number; derive: number; binance: number }>
    const result: Record<string, { bybit: number; okx: number; deribit: number; derive: number; binance: number }> = {}
    for (const [expiry, chainData] of Object.entries(optionsData.data)) {
      const counts = { bybit: 0, okx: 0, deribit: 0, derive: 0, binance: 0 }
      const contracts = [...((chainData as any).calls ?? []), ...((chainData as any).puts ?? [])]
      for (const c of contracts) {
        // Count by best bid/ask exchange — matches the badges shown in the chain
        const bidEx = (c as any).bestBidEx as ExchangeKey | null
        const askEx = (c as any).bestAskEx as ExchangeKey | null
        if (bidEx && activeExchanges.has(bidEx)) counts[bidEx]++
        if (askEx && askEx !== bidEx && activeExchanges.has(askEx)) counts[askEx]++
      }
      result[expiry] = counts
    }
    return result
  }, [exchange, optionsData, activeExchanges])

  const activeBoxSpreads = useMemo(
    () => boxSpreads.filter(b => b.legs.every(l => !l.exchange || activeExchanges.has(l.exchange as ExchangeKey))),
    [boxSpreads, activeExchanges]
  )

  const activeAllArbs = useMemo(
    () => allArbs.filter(a => a.legs.every(l => !l.exchange || activeExchanges.has(l.exchange as ExchangeKey))),
    [allArbs, activeExchanges]
  )

  const arbExpiryStrategies = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const b of activeBoxSpreads) {
      if (!map.has(b.expiry)) map.set(b.expiry, new Set())
      map.get(b.expiry)!.add(b.type === 'long' ? 'box_long' : 'box_short')
    }
    for (const a of activeAllArbs) {
      if (!map.has(a.expiry)) map.set(a.expiry, new Set())
      map.get(a.expiry)!.add(a.strategy)
    }
    return map
  }, [activeBoxSpreads, activeAllArbs])

  const boxSpreadsForExpiry = useMemo(
    () => activeBoxSpreads.filter(b => b.expiry === selectedExpiration),
    [activeBoxSpreads, selectedExpiration]
  )

  const arbsForExpiry = useMemo(
    () => activeAllArbs.filter(a => a.expiry === selectedExpiration),
    [activeAllArbs, selectedExpiration]
  )

  const chainData = selectedExpiration ? optionsData?.data?.[selectedExpiration] : undefined
  const effectiveSpotPrice = chainData?.forwardPrice || spotPrice
  const filteredExpirations = optionsData?.expirations ? filterExpirations(optionsData.expirations) : []
  const selectedScannerMeta = activeScanner ? SCANNER_META[activeScanner] : null
  const venueLabel = exchange === 'combined'
    ? 'Cross-venue'
    : exchange === 'okx'
      ? 'OKX'
      : exchange.charAt(0).toUpperCase() + exchange.slice(1)

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={exchange} onExchangeChange={handleExchangeChange} />

      <main className="container mx-auto px-4 py-5 space-y-4">
        <section className="surface-band px-5 py-5">
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="max-w-2xl">
                <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">Desk</div>
                <h1 className="heading-serif mt-2 text-3xl font-semibold text-ink">
                  {selectedCrypto} {venueLabel} volatility surface
                </h1>
                <p className="mt-2 text-sm leading-6 text-ink-2">Live chain, expiries, and scanners.</p>
              </div>

              <div className="grid min-w-[16rem] gap-2 text-sm sm:grid-cols-2">
                <div className="surface-well px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Venue scope</div>
                  <div className="mt-1 font-medium text-ink">{venueLabel}</div>
                </div>
                <div className="surface-well px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Selected expiry</div>
                  <div className="mt-1 font-medium text-ink">{selectedExpiration || 'Awaiting stream'}</div>
                </div>
                <div className="surface-well px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Reference spot</div>
                  <div className="mt-1 font-medium text-ink">
                    {effectiveSpotPrice > 0 ? `$${Math.round(effectiveSpotPrice).toLocaleString()}` : 'Loading'}
                  </div>
                </div>
                <div className="surface-well px-3 py-2">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Last update</div>
                  <div className="mt-1 font-medium text-ink">
                    {lastUpdated ? lastUpdated.toLocaleTimeString() : 'Waiting for feed'}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-3">
              <CryptocurrencyTabs
                selected={selectedCrypto}
                onSelect={handleCryptoChange}
                spotPrice={spotPrice}
                exchange={exchange}
              />
              {filteredExpirations.length > 0 && (
                <div className="min-w-0 flex-1">
                  <ExpirationTabs
                    expirations={filteredExpirations}
                    selected={selectedExpiration}
                    onSelect={(exp) => { selectedExpirationRef.current = exp; setSelectedExpiration(exp) }}
                    optionsCounts={optionsData?.expirationCounts ?? {}}
                    arbExpiryStrategies={arbExpiryStrategies}
                    expiryExchangeCounts={expiryExchangeCounts}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-start justify-between gap-3 border-t border-rim/75 pt-4">
              <div className="max-w-xl">
                <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">Research lenses</div>
                <p className="mt-1 text-sm text-ink-2">{selectedScannerMeta ? `${selectedScannerMeta.buttonLabel} active.` : 'Open a lens when needed.'}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(SCANNER_ORDER as ScannerKey[]).map((scannerKey) => (
                  <button
                    key={scannerKey}
                    onClick={() => setActiveScanner(v => v === scannerKey ? null : scannerKey)}
                    className={classNames(
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      activeScanner === scannerKey
                        ? SCANNER_META[scannerKey].activeClass
                        : SCANNER_META[scannerKey].idleClass
                    )}
                  >
                    {SCANNER_META[scannerKey].buttonLabel}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${activeScanner === 'gamma' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <GammaScanner
              optionsData={optionsData}
              spotPrice={spotPrice}
              coin={selectedCrypto}
              exchange={exchange}
              activeExchanges={activeExchanges}
            />
          </div>
        </div>
        <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${activeScanner === 'vega' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <VegaScanner
              optionsData={optionsData}
              spotPrice={spotPrice}
              coin={selectedCrypto}
              exchange={exchange}
              activeExchanges={activeExchanges}
            />
          </div>
        </div>
        <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${activeScanner === 'sell' ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <SellScanner
              optionsData={optionsData}
              spotPrice={spotPrice}
              coin={selectedCrypto}
              exchange={exchange}
              activeExchanges={activeExchanges}
            />
          </div>
        </div>

        {/* Options chain */}
        {loading ? (
          <div className="surface-band flex min-h-[16rem] items-center justify-center px-6 py-10">
            <div className="max-w-md text-center">
              <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">Refreshing research surface</div>
              <p className="mt-2 text-sm text-ink-2">
                Pulling live chain data for {selectedCrypto} across the selected venue scope.
              </p>
            </div>
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
          <div className="surface-band flex min-h-[16rem] items-center justify-center px-6 py-10">
            <div className="max-w-md text-center">
              <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">No active surface</div>
              <p className="mt-2 text-sm text-ink-2">
                {optionsData ? `No data is currently available for ${selectedExpiration}.` : 'Select an expiry to begin the desk view.'}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
