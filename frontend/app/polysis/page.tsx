'use client'

import { useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import Header from '@/components/Header'
import { buildPolysisDistributionChartData, formatPolysisConfidence, mapPolymarketResponse } from '@/lib/polysis.js'
import type { PolysisResponse, PolysisSourceMarket } from '@/types/polysis'

const ASSETS = ['BTC', 'ETH', 'SOL'] as const
const HORIZONS = ['daily', 'weekly', 'monthly', 'yearly'] as const
type DistributionRow = {
  label: string
  low: number
  high: number | null
  probability: number
}

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A'
  return `${value.toFixed(2)}%`
}

function marketTypeLabel(market: PolysisSourceMarket) {
  const type = market.classification?.type ?? 'unknown'
  if (type === 'range') return 'Range'
  if (type === 'threshold') return 'Threshold'
  if (type === 'path') return 'Path'
  return 'Unknown'
}

export default function PolysisPage() {
  const [asset, setAsset] = useState<typeof ASSETS[number]>('BTC')
  const [horizon, setHorizon] = useState<typeof HORIZONS[number]>('weekly')
  const [spotPrice, setSpotPrice] = useState('0')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [payload, setPayload] = useState<PolysisResponse | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadPolysis() {
      setLoading(true)
      setError(null)

      try {
        const query = Number(spotPrice) > 0 ? `?spotPrice=${encodeURIComponent(spotPrice)}` : ''
        const response = await fetch(`http://localhost:3500/api/polymarket/${asset}/${horizon}${query}`)
        const raw = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(raw?.error || `Server error ${response.status}`)
        }
        if (!cancelled) {
          setPayload(mapPolymarketResponse(raw) as PolysisResponse)
        }
      } catch (nextError) {
        if (!cancelled) {
          setPayload(null)
          setError(nextError instanceof Error ? nextError.message : 'Unable to load Polymarket data')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPolysis()
    return () => {
      cancelled = true
    }
  }, [asset, horizon, spotPrice])

  const distributionRows = useMemo<DistributionRow[]>(
    () => buildPolysisDistributionChartData(payload?.distribution ?? { bins: [] }),
    [payload],
  )

  const topProbability = distributionRows.reduce((max, row) => Math.max(max, row.probability), 0)
  const sourceMarkets = payload?.sourceMarkets ?? []
  const eligibleCount = payload?.confidence?.marketCount ?? sourceMarkets.length

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange="combined" onExchangeChange={() => {}} hideExchangeSelector />

      <main className="container mx-auto px-4 py-4 space-y-4">
        <section className="card overflow-hidden">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-2 max-w-2xl">
              <div className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-2">
                Polysis
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-ink">Prediction-Market Vol Detector</h1>
                <p className="mt-2 text-sm text-ink-2">
                  Read Polymarket crypto markets as a distribution surface. This page highlights expected move,
                  range concentration, and signal quality without mixing prediction-market prices into the options chain.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-rim bg-muted/60 px-3 py-2 text-xs">
                <div className="text-ink-3 uppercase tracking-[0.14em]">Signal</div>
                <div className="mt-1 font-medium text-ink">{formatPolysisConfidence(payload?.confidence ?? null)}</div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/60 px-3 py-2 text-xs">
                <div className="text-ink-3 uppercase tracking-[0.14em]">Markets Used</div>
                <div className="mt-1 font-medium text-ink">{eligibleCount}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="flex gap-1">
              {ASSETS.map((nextAsset) => (
                <button
                  key={nextAsset}
                  onClick={() => setAsset(nextAsset)}
                  className={classNames('px-3 py-1 rounded text-xs font-medium border transition-colors', {
                    'bg-tone text-white border-tone': asset === nextAsset,
                    'text-ink-2 border-rim hover:text-ink hover:border-ink-3': asset !== nextAsset,
                  })}
                >
                  {nextAsset}
                </button>
              ))}
            </div>

            <div className="flex gap-1">
              {HORIZONS.map((nextHorizon) => (
                <button
                  key={nextHorizon}
                  onClick={() => setHorizon(nextHorizon)}
                  className={classNames('px-3 py-1 rounded text-xs font-medium border capitalize transition-colors', {
                    'bg-card text-ink border-tone shadow-sm': horizon === nextHorizon,
                    'text-ink-2 border-rim hover:text-ink hover:border-ink-3': horizon !== nextHorizon,
                  })}
                >
                  {nextHorizon}
                </button>
              ))}
            </div>

            <label className="text-xs text-ink-2">
              Spot Override
              <input
                value={spotPrice}
                onChange={(event) => setSpotPrice(event.target.value)}
                inputMode="decimal"
                placeholder="optional"
                className="mt-1 block w-32 rounded border border-rim bg-card px-2 py-1 text-sm text-ink outline-none focus:border-tone"
              />
            </label>
          </div>
        </section>

        {error && (
          <section className="card text-sm text-rose-600 dark:text-rose-400">
            {error}
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="card space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">Implied Move</h2>
                <p className="mt-1 text-xs text-ink-3">Derived from the normalized Polymarket terminal distribution.</p>
              </div>
              {loading && <div className="text-xs text-ink-3">Loading…</div>}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-rim bg-muted/40 p-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Expected Price</div>
                <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(payload?.summary?.expectedPrice)}</div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/40 p-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Expected Move</div>
                <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(payload?.summary?.expectedMove)}</div>
                <div className="text-xs text-ink-3">{formatPercent(payload?.summary?.expectedMovePct)}</div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/40 p-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Most Likely Range</div>
                <div className="mt-2 text-lg font-semibold text-ink">
                  {payload?.summary?.mostLikelyRange
                    ? `${formatUsd(payload.summary.mostLikelyRange.low)}-${formatUsd(payload.summary.mostLikelyRange.high)}`
                    : 'N/A'}
                </div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/40 p-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Repricing</div>
                <div className="mt-2 text-sm font-medium text-ink">
                  24h: {formatPercent(payload?.repricing?.change24h)}
                </div>
                <div className="text-sm font-medium text-ink">
                  7d: {formatPercent(payload?.repricing?.change7d)}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-rim bg-card">
              <div className="border-b border-rim px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">Distribution Ladder</h3>
              </div>
              <div className="divide-y divide-rim">
                {!distributionRows.length && (
                  <div className="px-4 py-6 text-sm text-ink-3">No qualifying Polymarket bins available for this view yet.</div>
                )}

                {distributionRows.map((row) => (
                  <div key={row.label} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <div className="font-medium text-ink">{row.label}</div>
                      <div className="text-ink-2">{row.probability.toFixed(2)}%</div>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-tone transition-all"
                        style={{
                          width: topProbability > 0 ? `${(row.probability / topProbability) * 100}%` : '0%',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <section className="card">
              <h2 className="text-sm font-semibold text-ink">Signal Quality</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Confidence Score</div>
                  <div className="mt-2 text-lg font-semibold text-ink">{payload?.confidence?.score ?? 'N/A'}</div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Open Interest</div>
                  <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(payload?.confidence?.totalOpenInterest ?? null)}</div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Volume</div>
                  <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(payload?.confidence?.totalVolume ?? null)}</div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Distribution Source</div>
                  <div className="mt-2 text-lg font-semibold capitalize text-ink">{payload?.distribution?.source ?? 'N/A'}</div>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Source Markets</h2>
                  <p className="mt-1 text-xs text-ink-3">Markets feeding the detector, including any filtered-out entries.</p>
                </div>
                <div className="text-xs text-ink-3">{sourceMarkets.length} discovered</div>
              </div>

              <div className="mt-4 space-y-3">
                {!sourceMarkets.length && (
                  <div className="text-sm text-ink-3">No source markets found for this asset and horizon.</div>
                )}

                {sourceMarkets.map((market) => (
                  <article key={market.id} className="rounded-lg border border-rim bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-ink">{market.question}</div>
                        <div className="flex items-center gap-2 text-[11px] text-ink-3">
                          <span className="rounded-full border border-rim px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]">
                            {marketTypeLabel(market)}
                          </span>
                          <span>ID {market.id}</span>
                        </div>
                      </div>
                      <a
                        href={market.id ? `https://polymarket.com/event/${market.id}` : 'https://polymarket.com'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-tone hover:underline"
                      >
                        Open
                      </a>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs text-ink-2">
                      <div>Last price: {formatPercent((market.lastTradePrice ?? 0) * 100)}</div>
                      <div>Volume: {formatUsd(market.volumeNum ?? null)}</div>
                      <div>Open interest: {formatUsd(market.openInterest ?? null)}</div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  )
}
