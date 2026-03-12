'use client'

import { useEffect, useMemo, useState } from 'react'
import classNames from 'classnames'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import Header from '@/components/Header'
import {
  buildPolysisDistributionChartData,
  buildPolysisExpirySeries,
  formatPolysisConfidence,
  mapPolymarketResponse,
} from '@/lib/polysis.js'
import type { PolysisResponse, PolysisSourceMarket } from '@/types/polysis'

const ASSETS = ['BTC', 'ETH', 'SOL'] as const
const HORIZONS = ['daily', 'weekly', 'monthly', 'yearly'] as const

type HorizonKey = typeof HORIZONS[number]
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

function formatBarrier(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A'
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatExpiry(value: string | null | undefined) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function marketTypeLabel(market: PolysisSourceMarket) {
  const type = market.classification?.type ?? 'unknown'
  if (type === 'range') return 'Range'
  if (type === 'threshold') return 'Threshold'
  if (type === 'path') return 'Path'
  return 'Unknown'
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { horizon?: string; expiryDate?: string; movePct?: number | null; upPct?: number | null; downPct?: number | null; signalType?: string } }> }) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null

  return (
    <div className="rounded-lg border border-rim bg-card px-3 py-2 shadow-lg">
      <div className="text-xs uppercase tracking-[0.14em] text-ink-3">{point.horizon}</div>
      <div className="mt-1 text-sm font-medium text-ink">{formatExpiry(point.expiryDate)}</div>
      <div className="mt-2 space-y-1 text-xs text-ink-2">
        <div>Move: {formatPercent(point.movePct)}</div>
        <div>Up: {formatPercent(point.upPct)}</div>
        <div>Down: {formatPercent(point.downPct)}</div>
        <div>Mode: {point.signalType}</div>
      </div>
    </div>
  )
}

export default function PolysisPage() {
  const [asset, setAsset] = useState<typeof ASSETS[number]>('BTC')
  const [focusHorizon, setFocusHorizon] = useState<HorizonKey>('weekly')
  const [spotPrice, setSpotPrice] = useState('')
  const [referenceSpot, setReferenceSpot] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [payloads, setPayloads] = useState<Partial<Record<HorizonKey, PolysisResponse | null>>>({})

  useEffect(() => {
    let cancelled = false

    async function loadReferenceSpot() {
      try {
        const response = await fetch(`http://localhost:3500/api/combined/options/${asset}`)
        const raw = await response.json().catch(() => ({}))
        if (!cancelled) {
          const nextSpot = Number(raw?.spotPrice ?? 0)
          setReferenceSpot(Number.isFinite(nextSpot) && nextSpot > 0 ? nextSpot : null)
        }
      } catch {
        if (!cancelled) setReferenceSpot(null)
      }
    }

    loadReferenceSpot()
    return () => {
      cancelled = true
    }
  }, [asset])

  useEffect(() => {
    let cancelled = false

    async function loadPolysis() {
      setLoading(true)
      setError(null)

      try {
        const activeSpot = Number(spotPrice) > 0 ? Number(spotPrice) : referenceSpot
        const query = activeSpot && activeSpot > 0 ? `?spotPrice=${encodeURIComponent(activeSpot)}` : ''
        const responses = await Promise.all(HORIZONS.map(async (horizon) => {
          const response = await fetch(`http://localhost:3500/api/polymarket/${asset}/${horizon}${query}`)
          const raw = await response.json().catch(() => ({}))
          if (!response.ok) {
            throw new Error(`${horizon}: ${raw?.error || `Server error ${response.status}`}`)
          }
          return [horizon, mapPolymarketResponse(raw) as PolysisResponse] as const
        }))

        if (!cancelled) {
          const nextPayloads = Object.fromEntries(responses) as Partial<Record<HorizonKey, PolysisResponse>>
          setPayloads(nextPayloads)
          const firstAvailable = HORIZONS.find((key) => nextPayloads[key])
          setFocusHorizon((current) => (nextPayloads[current] ? current : (firstAvailable ?? 'weekly')))
        }
      } catch (nextError) {
        if (!cancelled) {
          setPayloads({})
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
  }, [asset, spotPrice, referenceSpot])

  const entries = useMemo(
    () => HORIZONS.map((horizon) => payloads[horizon]).filter(Boolean) as PolysisResponse[],
    [payloads],
  )

  const chartRows = useMemo(() => buildPolysisExpirySeries(entries), [entries])
  const focusedPayload = payloads[focusHorizon] ?? entries[0] ?? null
  const focusedDistribution = useMemo<DistributionRow[]>(
    () => buildPolysisDistributionChartData(focusedPayload?.distribution ?? { bins: [] }),
    [focusedPayload],
  )
  const topProbability = focusedDistribution.reduce((max, row) => Math.max(max, row.probability), 0)
  const sourceMarkets = focusedPayload?.sourceMarkets ?? []
  const pathMarkets = focusedPayload?.pathMarkets ?? []
  const strongestRow = chartRows.reduce<{ horizon?: string | null; movePct: number }>(
    (best, row) => (Number(row.movePct ?? -1) > best.movePct ? { horizon: row.horizon, movePct: Number(row.movePct) } : best),
    { movePct: -1 },
  )

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange="combined" onExchangeChange={() => {}} hideExchangeSelector />

      <main className="container mx-auto space-y-4 px-4 py-4">
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl space-y-2">
              <div className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-2">
                Polysis
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-ink">Prediction-Market Vol Surface</h1>
                <p className="mt-2 text-sm text-ink-2">
                  Plot Polymarket move signals by expiry. The x-axis is the market resolution date and the y-axis is the move metric,
                  using terminal move when a close ladder exists and path move when the market is dominated by reach or dip barriers.
                </p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-rim bg-muted/60 px-3 py-2 text-xs">
                <div className="text-ink-3 uppercase tracking-[0.14em]">Signal</div>
                <div className="mt-1 font-medium text-ink">{formatPolysisConfidence(focusedPayload?.confidence ?? null)}</div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/60 px-3 py-2 text-xs">
                <div className="text-ink-3 uppercase tracking-[0.14em]">Strongest Move</div>
                <div className="mt-1 font-medium text-ink">
                  {strongestRow.movePct >= 0 ? `${strongestRow.horizon}: ${formatPercent(strongestRow.movePct)}` : 'N/A'}
                </div>
              </div>
              <div className="rounded-lg border border-rim bg-muted/60 px-3 py-2 text-xs">
                <div className="text-ink-3 uppercase tracking-[0.14em]">Points</div>
                <div className="mt-1 font-medium text-ink">{chartRows.length}</div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="flex gap-1">
              {ASSETS.map((nextAsset) => (
                <button
                  key={nextAsset}
                  onClick={() => setAsset(nextAsset)}
                  className={classNames('rounded border px-3 py-1 text-xs font-medium transition-colors', {
                    'border-tone bg-tone text-white': asset === nextAsset,
                    'border-rim text-ink-2 hover:border-ink-3 hover:text-ink': asset !== nextAsset,
                  })}
                >
                  {nextAsset}
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
              <div className="mt-1 text-[11px] text-ink-3">
                {referenceSpot ? `Using ${formatUsd(referenceSpot)} by default` : 'Awaiting spot feed'}
              </div>
            </label>
          </div>
        </section>

        {error && <section className="card text-sm text-rose-600 dark:text-rose-400">{error}</section>}

        <section className="card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Expiry Move Chart</h2>
              <p className="mt-1 text-xs text-ink-3">Total move is shown for every available expiry. Up and down components appear when Polymarket gives a path ladder.</p>
            </div>
            {loading && <div className="text-xs text-ink-3">Loading…</div>}
          </div>

          <div className="mt-4 h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartRows} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                <CartesianGrid stroke="var(--color-rim, #e7ddd3)" strokeDasharray="3 3" />
                <XAxis dataKey="expiryLabel" tick={{ fontSize: 12, fill: '#8e7d6b' }} />
                <YAxis tickFormatter={(value) => `${value}%`} tick={{ fontSize: 12, fill: '#8e7d6b' }} width={52} />
                <Tooltip content={<ChartTooltip />} />
                <Line type="monotone" dataKey="movePct" name="Move %" stroke="#b5702d" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                <Line type="monotone" dataKey="upPct" name="Up %" stroke="#2f8f57" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                <Line type="monotone" dataKey="downPct" name="Down %" stroke="#b44a3c" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="card">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">Expiry Surface</h2>
                <p className="mt-1 text-xs text-ink-3">Each row is one horizon, keyed by its Polymarket expiry date.</p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {chartRows.map((row) => (
                <button
                  key={`${row.horizon}-${row.expiryDate}`}
                  onClick={() => setFocusHorizon((row.horizon as HorizonKey) ?? 'weekly')}
                  className={classNames('grid w-full gap-2 rounded-lg border px-3 py-3 text-left transition-colors sm:grid-cols-[0.9fr,1fr,0.8fr,0.8fr,0.8fr]', {
                    'border-tone bg-muted/40': focusHorizon === row.horizon,
                    'border-rim bg-card hover:border-ink-3': focusHorizon !== row.horizon,
                  })}
                >
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">{row.horizon}</div>
                    <div className="mt-1 text-sm font-medium text-ink">{row.expiryLabel}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Move</div>
                    <div className="mt-1 text-sm font-medium text-ink">{formatPercent(row.movePct)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Up</div>
                    <div className="mt-1 text-sm font-medium text-ink">{formatPercent(row.upPct)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Down</div>
                    <div className="mt-1 text-sm font-medium text-ink">{formatPercent(row.downPct)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Mode</div>
                    <div className="mt-1 text-sm font-medium capitalize text-ink">{row.signalType}</div>
                  </div>
                </button>
              ))}

              {!chartRows.length && (
                <div className="rounded-lg border border-rim bg-card px-4 py-6 text-sm text-ink-3">
                  No qualifying Polymarket expiries available for this asset.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <section className="card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Focused Expiry</h2>
                  <p className="mt-1 text-xs text-ink-3">
                    {focusedPayload ? `${focusedPayload.horizon} settling ${formatExpiry(focusedPayload.expiryDate)}` : 'Select an expiry row to inspect the underlying markets.'}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Move</div>
                  <div className="mt-2 text-lg font-semibold text-ink">
                    {formatPercent(focusedPayload?.pathSummary?.pathMovePct ?? focusedPayload?.summary?.expectedMovePct)}
                  </div>
                  <div className="text-xs text-ink-3">
                    {focusedPayload?.pathSummary?.pathMoveUsd ? formatUsd(focusedPayload.pathSummary.pathMoveUsd) : focusedPayload?.distribution?.source}
                  </div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Path Split</div>
                  <div className="mt-2 text-lg font-semibold text-ink">
                    {formatPercent(focusedPayload?.pathSummary?.upsidePathPct)} / {formatPercent(focusedPayload?.pathSummary?.downsidePathPct)}
                  </div>
                  <div className="text-xs text-ink-3">
                    {formatBarrier(focusedPayload?.pathSummary?.strongestUpsideBarrier)} / {formatBarrier(focusedPayload?.pathSummary?.strongestDownsideBarrier)}
                  </div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Open Interest</div>
                  <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(focusedPayload?.confidence?.totalOpenInterest ?? null)}</div>
                </div>
                <div className="rounded-lg border border-rim bg-muted/40 p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Volume</div>
                  <div className="mt-2 text-lg font-semibold text-ink">{formatUsd(focusedPayload?.confidence?.totalVolume ?? null)}</div>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="border-b border-rim px-0 pb-3">
                <h3 className="text-sm font-semibold text-ink">Focused Ladder</h3>
              </div>
              <div className="mt-3 divide-y divide-rim rounded-xl border border-rim bg-card">
                {!focusedDistribution.length && (
                  <div className="px-4 py-6 text-sm text-ink-3">
                    {pathMarkets.length
                      ? 'No terminal ladder for this expiry. The signal is path-based and represented in the move chart above.'
                      : 'No terminal ladder available for this expiry.'}
                  </div>
                )}
                {focusedDistribution.map((row) => (
                  <div key={row.label} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <div className="font-medium text-ink">{row.label}</div>
                      <div className="text-ink-2">{row.probability.toFixed(2)}%</div>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-tone transition-all"
                        style={{ width: topProbability > 0 ? `${(row.probability / topProbability) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Source Markets</h2>
                  <p className="mt-1 text-xs text-ink-3">The markets feeding the focused expiry signal.</p>
                </div>
                <div className="text-xs text-ink-3">{sourceMarkets.length} discovered</div>
              </div>

              <div className="mt-4 space-y-3">
                {!sourceMarkets.length && <div className="text-sm text-ink-3">No source markets found for this expiry.</div>}

                {sourceMarkets.map((market) => (
                  <article key={market.id} className="rounded-lg border border-rim bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-ink">{market.question}</div>
                        <div className="flex items-center gap-2 text-[11px] text-ink-3">
                          <span className="rounded-full border border-rim px-2 py-0.5 text-[10px] uppercase tracking-[0.14em]">
                            {marketTypeLabel(market)}
                          </span>
                          <span>{formatExpiry(market.endDate)}</span>
                        </div>
                      </div>
                      <a
                        href={market.slug ? `https://polymarket.com/event/${market.slug}` : 'https://polymarket.com'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-tone hover:underline"
                      >
                        Open
                      </a>
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-ink-2 sm:grid-cols-3">
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
