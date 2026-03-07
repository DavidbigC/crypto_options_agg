'use client'

import { useState, useEffect, useRef } from 'react'
import Header from '@/components/Header'
import CryptocurrencyTabs from '@/components/CryptocurrencyTabs'
import ExpirationTabs from '@/components/ExpirationTabs'
import OptionsChain from '@/components/OptionsChain'
import CombinedOptionsChain from '@/components/CombinedOptionsChain'
import { OptionsData, Exchange } from '@/types/options'

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
          setSelectedExpiration(data.expirations[0])
          selectedExpirationRef.current = data.expirations[0]
        }
      } catch {}
    }

    evtSource.onerror = () => {
      if (version !== fetchVersion.current) evtSource.close()
    }

    return () => evtSource.close()
  }, [selectedCrypto, exchange, selectedExpiration])

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
  }

  const chainData = selectedExpiration && optionsData?.data?.[selectedExpiration]
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
                expirations={optionsData.expirations}
                selected={selectedExpiration}
                onSelect={(exp) => { selectedExpirationRef.current = exp; setSelectedExpiration(exp) }}
                optionsCounts={optionsData.expirationCounts}
              />
            </div>
          )}
        </div>

        {/* Options chain */}
        {loading ? (
          <div className="card flex items-center justify-center h-64">
            <p className="text-ink-2 text-sm">Loading…</p>
          </div>
        ) : chainData ? (
          exchange === 'combined' ? (
            <CombinedOptionsChain
              data={chainData as any}
              spotPrice={effectiveSpotPrice}
              expiration={selectedExpiration}
              lastUpdated={lastUpdated}
            />
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
