'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import classNames from 'classnames'
import Header from '@/components/Header'
import { OptionsData } from '@/types/options'
import { filterExpirations } from '@/lib/filterExpirations'
import { apiPath, ssePath } from '@/lib/apiBase.js'
import { EX_ACTIVE, EX_SOFT, EX_NAME } from '@/lib/exchangeColors'
import { groupSurfaceBuckets } from '@/lib/surfaceGrouping.js'
import { deriveCombinedAnalysis } from '@/lib/liveCombinedAnalysis.js'
import {
  buildSkewChartData,
  buildTermStructureChartData,
  getDatasetFreshness,
} from '@/lib/analysisComparison.js'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const RESEARCH_EXCHANGES = ['combined', 'deribit', 'okx', 'bybit', 'binance'] as const
const OVERLAY_EXCHANGES = ['deribit', 'okx', 'bybit', 'binance'] as const
const EXCHANGE_COLORS: Record<string, string> = {
  combined: '#71717a',
  deribit: '#2563eb',
  okx: '#52525b',
  bybit: '#f59e0b',
  binance: '#ca8a04',
}
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000
const CORE_SURFACE_MAX_COLUMNS = 32

type OverlayExchange = typeof OVERLAY_EXCHANGES[number]
type ResearchExchange = typeof RESEARCH_EXCHANGES[number]
type ComparisonMode = 'level' | 'spread'
type SkewMetric = 'rr' | 'bf'
type AnalysisFit = { params: { a: number; b: number; rho: number; m: number; sigma: number }; rmse: number; T: number } | null
type SurfaceCell = {
  exp: string
  label: string
  dte: number
  bucketKey: number
  bucketLabel: string
  moneynessPct: number
  avgMarkIV: number
  count: number
  minStrike: number
  maxStrike: number
  optionTypes: string[]
}
type RawSurface = {
  expiries: Array<{ exp: string; label: string; dte: number }>
  buckets: Array<{ key: number; label: string; moneynessPct: number }>
  cells: SurfaceCell[]
}
type AnalysisPayload = {
  sviFits: Record<string, AnalysisFit>
  termStructure: Array<{ label: string; dte: number; atmIV: number; exp: string }>
  skewData: Array<{ label: string; rr: number; bf: number; exp: string }>
  rawSurface: RawSurface
  atmBboSpread: Array<{ exp: string; label: string; spreadUsd: number; spreadPct: number }>
  updatedAt: number
}

type LiveFreshness = {
  status: 'fresh' | 'aging' | 'stale' | 'missing'
  ageMs: number | null
  label: string
}

function getLiveStreamFreshness(updatedAt: number | null, now = Date.now()): LiveFreshness {
  if (!updatedAt) {
    return { status: 'missing', ageMs: null, label: 'Awaiting stream' }
  }

  const ageMs = Math.max(0, now - updatedAt)
  if (ageMs <= 15_000) {
    return { status: 'fresh', ageMs, label: 'Live' }
  }
  if (ageMs <= 45_000) {
    return { status: 'aging', ageMs, label: 'Quiet' }
  }
  return { status: 'stale', ageMs, label: 'Disconnected' }
}

function buildSmileChartData(
  selectedExpiration: string,
  optionsData: OptionsData | null,
  spotPrice: number,
  analysisByExchange: Record<ResearchExchange, AnalysisPayload | null>,
  overlays: OverlayExchange[]
) {
  if (!selectedExpiration || !optionsData || !spotPrice) return []

  const chain = optionsData.data[selectedExpiration]
  if (!chain) return []

  const rawMap = new Map<number, { mark: number; bid: number | null; ask: number | null }>()
  for (const c of chain.calls) {
    const mv = c.markVol ?? 0
    if (c.strike >= spotPrice && mv > 0) {
      rawMap.set(c.strike, {
        mark: mv * 100,
        bid: c.bidVol ? c.bidVol * 100 : null,
        ask: c.askVol ? c.askVol * 100 : null,
      })
    }
  }
  for (const p of chain.puts) {
    const mv = p.markVol ?? 0
    if (p.strike <= spotPrice && mv > 0 && !rawMap.has(p.strike)) {
      rawMap.set(p.strike, {
        mark: mv * 100,
        bid: p.bidVol ? p.bidVol * 100 : null,
        ask: p.askVol ? p.askVol * 100 : null,
      })
    }
  }

  const rawPoints = Array.from(rawMap.entries())
    .map(([strike, values]) => ({ strike, ...values }))
    .sort((a, b) => a.strike - b.strike)

  if (!rawPoints.length) return []

  const visibleExchanges = ['combined', ...overlays] as ResearchExchange[]
  const fitEntries = visibleExchanges
    .map((exchange) => ({
      exchange,
      fit: analysisByExchange[exchange]?.sviFits?.[selectedExpiration] ?? null,
    }))
    .filter((entry) => entry.fit)

  const logMoneys = rawPoints.map((point) => Math.log(point.strike / spotPrice))
  const kMin = Math.min(...logMoneys) - 0.05
  const kMax = Math.max(...logMoneys) + 0.05

  const curveRows = Array.from({ length: 120 }, (_, index) => {
    const k = kMin + (kMax - kMin) * index / 119
    const strike = spotPrice * Math.exp(k)
    const row: Record<string, number | null> = {
      x: strike,
      mark: null,
      bid: null,
      ask: null,
    }

    for (const { exchange, fit } of fitEntries) {
      if (!fit) continue
      const { a, b, rho, m, sigma } = fit.params
      const d = k - m
      const w = a + b * (rho * d + Math.sqrt(d * d + sigma * sigma))
      const iv = w > 0 ? Math.sqrt(w / fit.T) * 100 : 0
      row[`fit_${exchange}`] = iv > 0 && iv < 500 ? iv : null
    }

    return row
  })

  const rawRows = rawPoints.map((point) => ({
    x: point.strike,
    mark: point.mark,
    bid: point.bid,
    ask: point.ask,
  }))

  return [...curveRows, ...rawRows].sort((a, b) => Number(a.x) - Number(b.x))
}

export default function AnalysisPage() {
  const [selectedCrypto, setSelectedCrypto] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [selectedExpiration, setSelectedExpiration] = useState<string>('')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState<number>(0)
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [overlayAnalysisByExchange, setOverlayAnalysisByExchange] = useState<Record<OverlayExchange, AnalysisPayload | null>>({
    deribit: null,
    okx: null,
    bybit: null,
    binance: null,
  })
  const [overlayAnalysisErrors, setOverlayAnalysisErrors] = useState<Record<OverlayExchange, string | null>>({
    deribit: null,
    okx: null,
    bybit: null,
    binance: null,
  })
  const [lastCombinedEventAt, setLastCombinedEventAt] = useState<number | null>(null)
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())
  const [overlayVisibility, setOverlayVisibility] = useState<Record<OverlayExchange, boolean>>({
    deribit: true,
    okx: true,
    bybit: false,
    binance: false,
  })
  const [termMode, setTermMode] = useState<ComparisonMode>('level')
  const [skewMode, setSkewMode] = useState<ComparisonMode>('level')
  const [skewMetric, setSkewMetric] = useState<SkewMetric>('rr')
  const [surfaceRangeMode, setSurfaceRangeMode] = useState<'core' | 'full'>('core')
  const [surfaceActiveExchanges, setSurfaceActiveExchanges] = useState<Set<OverlayExchange>>(new Set(OVERLAY_EXCHANGES))
  const [activeSurfaceKey, setActiveSurfaceKey] = useState<string | null>(null)
  const fetchVersion = useRef(0)
  const selectedExpirationRef = useRef('')

  useEffect(() => {
    const id = window.setInterval(() => setFreshnessNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    fetchVersion.current++
    const version = fetchVersion.current
    setLoadingOptions(true)
    setOptionsData(null)
    setSpotPrice(0)
    setLastCombinedEventAt(null)
    setSelectedExpiration('')
    selectedExpirationRef.current = ''

    const evtSource = new EventSource(ssePath(`stream/combined/${selectedCrypto}`))

    evtSource.onmessage = (e) => {
      if (version !== fetchVersion.current) {
        evtSource.close()
        return
      }

      try {
        const data = JSON.parse(e.data)
        if (!data || data.error || !data.data) return

        setOptionsData((prev) => {
          if (!prev) return data
          const mergedData = { ...prev.data }
          for (const [exp, chain] of Object.entries(data.data as Record<string, { calls: any[]; puts: any[] }>)) {
            if (prev.data[exp]) {
              const mergeIV = (previous: any, next: any) => ({
                ...previous,
                ...next,
                markVol: next.markVol || previous?.markVol,
                bidVol: next.bidVol || previous?.bidVol,
                askVol: next.askVol || previous?.askVol,
              })
              const callMap = new Map(prev.data[exp].calls.map((contract: any) => [contract.strike, contract]))
              for (const contract of chain.calls) callMap.set(contract.strike, mergeIV(callMap.get(contract.strike), contract))
              const putMap = new Map(prev.data[exp].puts.map((contract: any) => [contract.strike, contract]))
              for (const contract of chain.puts) putMap.set(contract.strike, mergeIV(putMap.get(contract.strike), contract))
              mergedData[exp] = { calls: Array.from(callMap.values()), puts: Array.from(putMap.values()) }
            } else {
              mergedData[exp] = chain
            }
          }
          return {
            ...prev,
            data: mergedData,
            spotPrice: data.spotPrice ?? prev.spotPrice,
            expirations: data.expirations?.length ? data.expirations : prev.expirations,
          }
        })

        if (data.spotPrice > 0) setSpotPrice(data.spotPrice)
        setLastCombinedEventAt(Date.now())
        setLoadingOptions(false)

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
  }, [selectedCrypto])

  useEffect(() => {
    let cancelled = false

    async function fetchAllAnalysis() {
      const results = await Promise.all(OVERLAY_EXCHANGES.map(async (exchange) => {
        try {
          const response = await fetch(apiPath(`analysis/${exchange}/${selectedCrypto}`))
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            throw new Error(payload?.error || `HTTP ${response.status}`)
          }
          return [exchange, { data: payload as AnalysisPayload, error: null }] as const
        } catch (error) {
          return [exchange, { data: null, error: error instanceof Error ? error.message : 'Unavailable' }] as const
        }
      }))

      if (cancelled) return

      const nextData = { deribit: null, okx: null, bybit: null, binance: null } as Record<OverlayExchange, AnalysisPayload | null>
      const nextErrors = { deribit: null, okx: null, bybit: null, binance: null } as Record<OverlayExchange, string | null>

      for (const [exchange, result] of results) {
        nextData[exchange] = result.data
        nextErrors[exchange] = result.error
      }

      setOverlayAnalysisByExchange(nextData)
      setOverlayAnalysisErrors(nextErrors)
      setActiveSurfaceKey(null)
    }

    fetchAllAnalysis()
    const id = setInterval(fetchAllAnalysis, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedCrypto])

  const expirations = useMemo(
    () => filterExpirations(optionsData?.expirations ?? []),
    [optionsData]
  )

  const visibleOverlays = OVERLAY_EXCHANGES.filter((exchange) => overlayVisibility[exchange])
  const combinedAnalysis = useMemo<AnalysisPayload | null>(
    () => deriveCombinedAnalysis(optionsData, spotPrice || optionsData?.spotPrice || 0, lastCombinedEventAt ?? freshnessNow) as AnalysisPayload | null,
    [optionsData, spotPrice, lastCombinedEventAt]
  )
  const analysisByExchange = useMemo<Record<ResearchExchange, AnalysisPayload | null>>(() => ({
    combined: combinedAnalysis,
    deribit: overlayAnalysisByExchange.deribit,
    okx: overlayAnalysisByExchange.okx,
    bybit: overlayAnalysisByExchange.bybit,
    binance: overlayAnalysisByExchange.binance,
  }), [combinedAnalysis, overlayAnalysisByExchange])
  const analysisErrors = useMemo<Record<ResearchExchange, string | null>>(() => ({
    combined: null,
    deribit: overlayAnalysisErrors.deribit,
    okx: overlayAnalysisErrors.okx,
    bybit: overlayAnalysisErrors.bybit,
    binance: overlayAnalysisErrors.binance,
  }), [overlayAnalysisErrors])
  const smileChartData = useMemo(
    () => buildSmileChartData(selectedExpiration, optionsData, spotPrice, analysisByExchange, visibleOverlays),
    [selectedExpiration, optionsData, spotPrice, analysisByExchange, visibleOverlays]
  )
  const smileFits = useMemo(() => {
    const fits: Partial<Record<ResearchExchange, NonNullable<AnalysisFit>>> = {}
    for (const exchange of ['combined', ...visibleOverlays] as ResearchExchange[]) {
      const fit = analysisByExchange[exchange]?.sviFits?.[selectedExpiration] ?? null
      if (fit) fits[exchange] = fit
    }
    return fits
  }, [analysisByExchange, selectedExpiration, visibleOverlays])
  const termChartData = useMemo(
    () => buildTermStructureChartData(analysisByExchange, visibleOverlays, termMode),
    [analysisByExchange, visibleOverlays, termMode]
  )
  const atmSpreadChartData = analysisByExchange.combined?.atmBboSpread ?? []
  const skewChartData = useMemo(
    () => buildSkewChartData(analysisByExchange, visibleOverlays, skewMetric, skewMode),
    [analysisByExchange, visibleOverlays, skewMetric, skewMode]
  )
  const combinedSurface = combinedAnalysis?.rawSurface ?? null

  const mergedSurface = useMemo<RawSurface | null>(() => {
    const activeList = OVERLAY_EXCHANGES.filter(ex => surfaceActiveExchanges.has(ex))
    if (activeList.length === 0) return null
    // All selected → use combined (authoritative)
    if (activeList.length === OVERLAY_EXCHANGES.length) return analysisByExchange.combined?.rawSurface ?? null
    // Partial → merge selected exchange surfaces
    const cellAccum = new Map<string, { ivSum: number; weightSum: number; exp: string; bucketKey: number; label: string; bucketLabel: string; moneynessPct: number; dte: number; minStrike: number; maxStrike: number; optionTypes: Set<string> }>()
    const expirySet = new Map<string, { exp: string; label: string; dte: number }>()
    const bucketSet = new Map<number, { key: number; label: string; moneynessPct: number }>()
    for (const ex of activeList) {
      const surface = analysisByExchange[ex]?.rawSurface
      if (!surface) continue
      for (const exp of surface.expiries) expirySet.set(exp.exp, exp)
      for (const bucket of surface.buckets) bucketSet.set(bucket.key, bucket)
      for (const cell of surface.cells) {
        const key = `${cell.bucketKey}|${cell.exp}`
        if (!cellAccum.has(key)) {
          cellAccum.set(key, { ivSum: 0, weightSum: 0, exp: cell.exp, bucketKey: cell.bucketKey, label: cell.label, bucketLabel: cell.bucketLabel, moneynessPct: cell.moneynessPct, dte: cell.dte, minStrike: cell.minStrike, maxStrike: cell.maxStrike, optionTypes: new Set() })
        }
        const a = cellAccum.get(key)!
        a.ivSum += cell.avgMarkIV * cell.count
        a.weightSum += cell.count
        a.minStrike = Math.min(a.minStrike, cell.minStrike)
        a.maxStrike = Math.max(a.maxStrike, cell.maxStrike)
        cell.optionTypes.forEach(t => a.optionTypes.add(t))
      }
    }
    const cells: SurfaceCell[] = Array.from(cellAccum.values())
      .filter(c => c.weightSum > 0)
      .map(c => ({ exp: c.exp, label: c.label, dte: c.dte, bucketKey: c.bucketKey, bucketLabel: c.bucketLabel, moneynessPct: c.moneynessPct, avgMarkIV: Number((c.ivSum / c.weightSum).toFixed(1)), count: c.weightSum, minStrike: c.minStrike, maxStrike: c.maxStrike, optionTypes: Array.from(c.optionTypes) }))
    const expiriesWithData = new Set(cells.map(c => c.exp))
    const expiries = Array.from(expirySet.values()).filter(e => expiriesWithData.has(e.exp)).sort((a, b) => a.dte - b.dte)
    const buckets = Array.from(bucketSet.values()).sort((a, b) => a.key - b.key)
    return { expiries, buckets, cells }
  }, [analysisByExchange, surfaceActiveExchanges])

  const surfaceData = useMemo<RawSurface | null>(() => {
    if (!mergedSurface) return null
    return surfaceRangeMode === 'core'
      ? groupSurfaceBuckets(mergedSurface, CORE_SURFACE_MAX_COLUMNS)
      : mergedSurface
  }, [mergedSurface, surfaceRangeMode])
  const surfaceCells = surfaceData?.cells ?? []
  const surfaceCellMap = useMemo(() => {
    const map = new Map<string, SurfaceCell>()
    for (const cell of surfaceCells) {
      map.set(`${cell.bucketKey}|${cell.exp}`, cell)
    }
    return map
  }, [surfaceCells])
  const visibleBuckets: RawSurface['buckets'] = surfaceData?.buckets ?? []

  const activeSurfaceDetails: SurfaceCell | null = activeSurfaceKey ? surfaceCellMap.get(activeSurfaceKey) ?? null : surfaceCells[0] ?? null
  const selectedFit = smileFits.combined ?? null
  const hasSmileData = smileChartData.some((row) => row.mark !== null)

  const freshnessByExchange = useMemo(() => {
    return RESEARCH_EXCHANGES.reduce((acc, exchange) => {
      acc[exchange] = exchange === 'combined'
        ? getLiveStreamFreshness(lastCombinedEventAt, freshnessNow)
        : getDatasetFreshness(analysisByExchange[exchange]?.updatedAt ?? null, freshnessNow)
      return acc
    }, {} as Record<ResearchExchange, LiveFreshness | ReturnType<typeof getDatasetFreshness>>)
  }, [analysisByExchange, lastCombinedEventAt, freshnessNow])

  const surfaceValueRange = useMemo(() => {
    // Anchor to the combined backend surface so toggling individual exchanges
    // never shifts the colour mapping for the same IV value.
    // If combined hasn't loaded yet, build a reference from ALL exchange surfaces
    // (not just the active ones) so the scale is still toggle-independent.
    const referenceCells: SurfaceCell[] = combinedSurface?.cells
      ?? OVERLAY_EXCHANGES.flatMap(ex => analysisByExchange[ex]?.rawSurface?.cells ?? [])
    if (!referenceCells.length) return { min: 0, max: 0 }
    const values = referenceCells.map(c => c.avgMarkIV)
    return { min: Math.min(...values), max: Math.max(...values) }
  }, [combinedSurface, analysisByExchange])

  const colorForSurfaceCell = (cell: SurfaceCell | null) => {
    if (!cell) return 'rgba(148, 163, 184, 0.08)'
    if (surfaceValueRange.max <= surfaceValueRange.min) return 'rgba(59, 130, 246, 0.28)'
    const ratio = Math.max(0, Math.min(1, (cell.avgMarkIV - surfaceValueRange.min) / (surfaceValueRange.max - surfaceValueRange.min)))
    const hue = 212 - ratio * 164
    const lightness = 92 - ratio * 42
    return `hsl(${hue.toFixed(0)} 78% ${lightness.toFixed(0)}%)`
  }

  const toggleOverlay = (exchange: OverlayExchange) => {
    setOverlayVisibility((previous) => ({ ...previous, [exchange]: !previous[exchange] }))
  }

  const toggleSurfaceExchange = (ex: OverlayExchange) => {
    setSurfaceActiveExchanges(prev => {
      const next = new Set(prev)
      if (next.has(ex)) {
        if (next.size === 1) return prev
        next.delete(ex)
      } else {
        next.add(ex)
      }
      return next
    })
  }

  const fmtExpiry = (exp: string) => new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange="combined" onExchangeChange={() => {}} hideExchangeSelector />

      <main className="container mx-auto px-4 py-5 space-y-4">
        <div className="surface-band space-y-4 px-5 py-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em] text-ink-3">Comparative research</div>
              <h1 className="heading-serif mt-2 text-3xl font-semibold text-ink">Volatility research dashboard</h1>
              <p className="mt-2 max-w-3xl text-sm text-ink-2">
                Combined is the market anchor. Use venue overlays to compare smile, tenor, skew, and surface dislocations.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {RESEARCH_EXCHANGES.map((exchange) => {
                const freshness = freshnessByExchange[exchange]
                return (
                  <div
                    key={exchange}
                    className={classNames('rounded border px-2 py-1 text-[11px]', EX_SOFT[exchange], {
                      'border-rose-200 text-rose-700 dark:text-rose-400': freshness.status === 'stale' || analysisErrors[exchange],
                      'opacity-70': freshness.status === 'aging',
                      'opacity-55': freshness.status === 'missing' && !analysisErrors[exchange],
                    })}
                  >
                    <span className="font-medium">{EX_NAME[exchange]}</span> · {analysisErrors[exchange] ? 'Unavailable' : freshness.label}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex items-start gap-3 flex-wrap">
            <div className="flex gap-1 flex-shrink-0">
              {(['BTC', 'ETH', 'SOL'] as const).map((coin) => (
                <button
                  key={coin}
                  onClick={() => {
                    setSelectedCrypto(coin)
                    setSelectedExpiration('')
                    selectedExpirationRef.current = ''
                    setActiveSurfaceKey(null)
                  }}
                  className={classNames('px-3 py-1 rounded text-xs font-medium transition-colors border', {
                    'bg-tone text-white border-tone': selectedCrypto === coin,
                    'text-ink-2 border-rim hover:text-ink hover:border-ink-3': selectedCrypto !== coin,
                  })}
                >
                  {coin}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">Overlays</div>
                  {OVERLAY_EXCHANGES.map((exchange) => (
                <button
                  key={exchange}
                  onClick={() => toggleOverlay(exchange)}
                  className={classNames('px-2.5 py-1 rounded text-[11px] border transition-colors', {
                    [EX_ACTIVE[exchange]]: overlayVisibility[exchange],
                    'text-ink-2 border-rim hover:text-ink hover:border-ink-3': !overlayVisibility[exchange],
                  })}
                >
                  {EX_NAME[exchange]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {expirations.map((exp) => (
              <button
                key={exp}
                onClick={() => {
                  selectedExpirationRef.current = exp
                  setSelectedExpiration(exp)
                }}
                className={classNames('px-2 py-0.5 rounded text-[10px] font-mono border transition-colors', {
                  'bg-tone text-white border-tone': selectedExpiration === exp,
                  'text-ink-2 border-rim hover:border-ink-3 hover:text-ink': selectedExpiration !== exp,
                })}
              >
                {fmtExpiry(exp)}
              </button>
            ))}
          </div>
        </div>

        {loadingOptions ? (
          <div className="card flex items-center justify-center h-64">
            <p className="text-ink-2 text-sm">Loading combined market data…</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="card">
                <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">
                      IV Smile Comparison — {selectedExpiration ? fmtExpiry(selectedExpiration) : '—'}
                    </h2>
                    <p className="text-xs text-ink-3 mt-0.5">
                      Combined raw OTM IV anchors the chart. Venue overlays show where fitted curves diverge from market consensus.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3 text-[11px] text-ink-3">
                    {(['combined', ...visibleOverlays] as ResearchExchange[]).map((exchange) => {
                      const fit = smileFits[exchange]
                      return (
                        <span key={exchange}>
                          <span className="font-medium" style={{ color: EXCHANGE_COLORS[exchange] }}>
                            {EX_NAME[exchange]}
                          </span>{' '}
                          {fit ? `RMSE ${(fit.rmse * 100).toFixed(3)}` : 'no fit'}
                        </span>
                      )
                    })}
                  </div>
                </div>

                {!hasSmileData ? (
                  <div className="flex items-center justify-center h-72 text-sm text-ink-3">
                    Combined smile data is still warming up.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={340}>
                    <LineChart data={smileChartData} margin={{ top: 5, right: 24, left: 0, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis
                        dataKey="x"
                        type="number"
                        scale="linear"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={(value) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : String(value)}
                        tick={{ fontSize: 11 }}
                        label={{ value: 'Strike', position: 'insideBottom', offset: -10, fontSize: 11 }}
                      />
                      <YAxis
                        tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                        tick={{ fontSize: 11 }}
                        width={44}
                        label={{ value: 'IV', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11 }}
                      />
                      <Tooltip
                        formatter={(value: any, name: string) => {
                          if (value == null) return [null, name]
                          const cleanName = name.startsWith('fit_') ? `${name.replace('fit_', '')} fit` : name
                          return [`${parseFloat(value).toFixed(2)}%`, cleanName]
                        }}
                        labelFormatter={(value) => `Strike: ${Number(value).toLocaleString()}`}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <ReferenceLine
                        x={spotPrice}
                        stroke="var(--color-tone, #f59e0b)"
                        strokeDasharray="4 2"
                        strokeWidth={1.5}
                        label={{ value: 'Spot', position: 'top', fontSize: 10 }}
                      />
                      {(['combined', ...visibleOverlays] as ResearchExchange[]).map((exchange) => (
                        <Line
                          key={exchange}
                          dataKey={`fit_${exchange}`}
                          name={`fit_${exchange}`}
                          connectNulls
                          dot={false}
                          strokeWidth={exchange === 'combined' ? 2.5 : 1.75}
                          stroke={EXCHANGE_COLORS[exchange]}
                          strokeDasharray={exchange === 'combined' ? undefined : '4 2'}
                          isAnimationActive={false}
                        />
                      ))}
                      <Line
                        dataKey="bid"
                        name="Bid IV"
                        connectNulls={false}
                        strokeWidth={0}
                        dot={{ r: 3, fill: '#d1d5db', stroke: '#9ca3af', strokeWidth: 1 }}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="ask"
                        name="Ask IV"
                        connectNulls={false}
                        strokeWidth={0}
                        dot={{ r: 3, fill: '#d1d5db', stroke: '#9ca3af', strokeWidth: 1 }}
                        activeDot={{ r: 4 }}
                        isAnimationActive={false}
                      />
                      <Line
                        dataKey="mark"
                        name="Combined mark IV"
                        connectNulls={false}
                        strokeWidth={0}
                        dot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 1.5 }}
                        activeDot={{ r: 6 }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="card">
                <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">25Δ Skew &amp; Butterfly</h2>
                    <p className="text-xs text-ink-3 mt-0.5">
                      Toggle between risk reversal and fly, then compare outright levels or spreads versus combined.
                    </p>
                  </div>
                  <div className="flex gap-3 flex-wrap">
                    <div className="flex gap-1">
                      {(['rr', 'bf'] as const).map((metric) => (
                        <button
                          key={metric}
                          onClick={() => setSkewMetric(metric)}
                          className={classNames('px-2 py-1 rounded text-[11px] border transition-colors', {
                            'bg-tone text-white border-tone': skewMetric === metric,
                            'text-ink-2 border-rim hover:text-ink hover:border-ink-3': skewMetric !== metric,
                          })}
                        >
                          {metric === 'rr' ? '25Δ RR' : '25Δ Fly'}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      {(['level', 'spread'] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setSkewMode(mode)}
                          className={classNames('px-2 py-1 rounded text-[11px] border transition-colors', {
                            'bg-tone text-white border-tone': skewMode === mode,
                            'text-ink-2 border-rim hover:text-ink hover:border-ink-3': skewMode !== mode,
                          })}
                        >
                          {mode === 'level' ? 'Level' : 'Spread'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {skewChartData.length === 0 ? (
                  <div className="flex items-center justify-center h-56 text-sm text-ink-3">
                    Combined skew data is unavailable for the selected coin.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={skewChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={(value) => `${Number(value).toFixed(1)}%`} tick={{ fontSize: 11 }} width={42} />
                      <Tooltip
                        formatter={(value: any, name: string) => [
                          `${parseFloat(value).toFixed(2)}${skewMode === 'spread' ? ' vol pts' : '%'}`,
                          name,
                        ]}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={0} stroke="var(--color-rim, #e5e7eb)" />
                      {(['combined', ...visibleOverlays] as ResearchExchange[]).map((exchange) => (
                        <Line
                          key={exchange}
                          dataKey={exchange}
                          stroke={EXCHANGE_COLORS[exchange]}
                          strokeWidth={exchange === 'combined' ? 2.5 : 1.75}
                          strokeDasharray={exchange === 'combined' ? undefined : '4 2'}
                          dot={{ r: exchange === 'combined' ? 4 : 3, strokeWidth: 0 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="card">
                <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">ATM IV Term Structure</h2>
                    <p className="text-xs text-ink-3 mt-0.5">
                      Compare venue ATM IV levels or spreads versus combined across tenor.
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {(['level', 'spread'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setTermMode(mode)}
                        className={classNames('px-2 py-1 rounded text-[11px] border transition-colors', {
                          'bg-tone text-white border-tone': termMode === mode,
                          'text-ink-2 border-rim hover:text-ink hover:border-ink-3': termMode !== mode,
                        })}
                      >
                        {mode === 'level' ? 'Level' : 'Spread'}
                      </button>
                    ))}
                  </div>
                </div>
                {termChartData.length < 2 ? (
                  <div className="flex items-center justify-center h-56 text-sm text-ink-3">
                    Need at least two combined expiries with ATM IV data.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={termChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={(value) => `${Number(value).toFixed(1)}%`} tick={{ fontSize: 11 }} width={42} />
                      <Tooltip
                        formatter={(value: any, name: string) => [
                          `${parseFloat(value).toFixed(2)}${termMode === 'spread' ? ' vol pts' : '%'}`,
                          name,
                        ]}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={0} stroke="var(--color-rim, #e5e7eb)" />
                      {(['combined', ...visibleOverlays] as ResearchExchange[]).map((exchange) => (
                        <Line
                          key={exchange}
                          dataKey={exchange}
                          stroke={EXCHANGE_COLORS[exchange]}
                          strokeWidth={exchange === 'combined' ? 2.5 : 1.75}
                          strokeDasharray={exchange === 'combined' ? undefined : '4 2'}
                          dot={{ r: exchange === 'combined' ? 4 : 3, strokeWidth: 0 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="card">
                <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h2 className="text-sm font-semibold text-ink">ATM BBO Spread by Expiry</h2>
                    <p className="text-xs text-ink-3 mt-0.5">
                      Average the ATM call and put bid/ask spread for each expiry, shown in USD and as a percent of mid.
                    </p>
                  </div>
                </div>
                {atmSpreadChartData.length === 0 ? (
                  <div className="flex items-center justify-center h-56 text-sm text-ink-3">
                    No valid ATM bid/ask spread data is available across expiries.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={atmSpreadChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis yAxisId="usd" tickFormatter={(value) => `$${Number(value).toFixed(0)}`} tick={{ fontSize: 11 }} width={48} />
                      <YAxis yAxisId="pct" orientation="right" tickFormatter={(value) => `${Number(value).toFixed(1)}%`} tick={{ fontSize: 11 }} width={44} />
                      <Tooltip
                        formatter={(value: any, name: string) => [
                          name === 'Spread % of mid'
                            ? `${parseFloat(value).toFixed(2)}%`
                            : `$${parseFloat(value).toFixed(2)}`,
                          name,
                        ]}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine yAxisId="usd" y={0} stroke="var(--color-rim, #e5e7eb)" />
                      <Line
                        yAxisId="usd"
                        type="monotone"
                        dataKey="spreadUsd"
                        name="Spread USD"
                        stroke="#2563eb"
                        strokeWidth={2.25}
                        dot={{ r: 4, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="pct"
                        type="monotone"
                        dataKey="spreadPct"
                        name="Spread % of mid"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeDasharray="4 2"
                        dot={{ r: 3, strokeWidth: 0 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="card">
              <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Surface Research View</h2>
                  <p className="text-xs text-ink-3 mt-0.5">Raw OTM IV across tenor and moneyness.</p>
                </div>
                <div className="flex gap-3 flex-wrap">
                  <div className="flex gap-1">
                    {(['core', 'full'] as const).map((range) => (
                      <button
                        key={range}
                        onClick={() => setSurfaceRangeMode(range)}
                        className={classNames('px-2 py-1 rounded text-[11px] border transition-colors', {
                          'bg-tone text-white border-tone': surfaceRangeMode === range,
                          'text-ink-2 border-rim hover:text-ink hover:border-ink-3': surfaceRangeMode !== range,
                        })}
                      >
                        {range === 'core' ? 'Fit' : 'Full'}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1">
                    {OVERLAY_EXCHANGES.map((ex) => (
                      <button
                        key={ex}
                        onClick={() => toggleSurfaceExchange(ex)}
                        className={classNames('px-2 py-1 rounded text-[11px] font-medium border transition-colors', {
                          [EX_ACTIVE[ex]]: surfaceActiveExchanges.has(ex),
                          'text-ink-2 border-rim hover:text-ink hover:border-ink-3': !surfaceActiveExchanges.has(ex),
                        })}
                      >
                        {EX_NAME[ex]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mb-4 text-[11px] text-ink-3">
                <div className="font-medium text-ink">
                  {activeSurfaceDetails ? `${activeSurfaceDetails.label} · ${activeSurfaceDetails.bucketLabel}` : '\u00a0'}
                </div>
                <div>
                  {activeSurfaceDetails
                    ? `${activeSurfaceDetails.avgMarkIV.toFixed(1)}% IV · ${activeSurfaceDetails.count} contract${activeSurfaceDetails.count === 1 ? '' : 's'} · strikes ${activeSurfaceDetails.minStrike.toLocaleString()}-${activeSurfaceDetails.maxStrike.toLocaleString()}`
                    : '\u00a0'}
                </div>
              </div>

              {!surfaceData || surfaceData.expiries.length === 0 || surfaceData.buckets.length === 0 || surfaceData.cells.length === 0 ? (
                <div className="flex items-center justify-center h-56 text-sm text-ink-3">
                  No surface data available.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="overflow-x-auto">
                    <div
                      className="grid gap-1"
                      style={{ gridTemplateColumns: `80px repeat(${visibleBuckets.length}, minmax(38px, 1fr))` }}
                    >
                      {/* Header row: tenor label + moneyness bucket headers */}
                      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3 px-2 py-1">Tenor</div>
                      {visibleBuckets.map((bucket) => (
                        <div key={bucket.key} className="px-1 py-1 text-center">
                          <div className="text-[10px] font-medium text-ink-3">{bucket.label}</div>
                        </div>
                      ))}

                      {/* Data rows: one per expiry */}
                      {surfaceData.expiries.map((expiry) => (
                        <div key={`row-${expiry.exp}`} className="contents">
                          <div className="flex flex-col justify-center px-2 py-0.5">
                            <div className="text-[11px] font-medium text-ink">{expiry.label}</div>
                            <div className="text-[10px] text-ink-3">{expiry.dte}d</div>
                          </div>
                          {visibleBuckets.map((bucket) => {
                            const key = `${bucket.key}|${expiry.exp}`
                            const cell = surfaceCellMap.get(key) ?? null
                            const lowConfidence = cell ? cell.count <= 1 : false

                            return (
                              <button
                                key={key}
                                type="button"
                                onMouseEnter={() => setActiveSurfaceKey(key)}
                                onFocus={() => setActiveSurfaceKey(key)}
                                className={classNames('h-8 rounded border transition-colors', {
                                  'opacity-60': lowConfidence,
                                })}
                                style={{
                                  backgroundColor: colorForSurfaceCell(cell),
                                  borderColor: cell ? 'rgba(255, 255, 255, 0.18)' : 'rgba(148, 163, 184, 0.12)',
                                }}
                                title={!cell ? `${expiry.label} · ${bucket.label} · no data` : `${expiry.label} · ${bucket.label} · ${cell.avgMarkIV.toFixed(1)}% IV`}
                              >
                                <span className="sr-only">
                                  {!cell ? 'No data' : `${cell.avgMarkIV.toFixed(1)} percent implied volatility`}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 text-[10px] text-ink-3">
                    <span className="shrink-0">{surfaceValueRange.min.toFixed(0)}% IV</span>
                    <div
                      className="flex-1 h-2.5 rounded"
                      style={{ background: 'linear-gradient(to right, hsl(212,78%,92%), hsl(160,78%,72%), hsl(100,78%,62%), hsl(48,78%,50%))' }}
                    />
                    <span className="shrink-0">{surfaceValueRange.max.toFixed(0)}% IV</span>
                    <span className="shrink-0 ml-1">low → high</span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
