'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import classNames from 'classnames'
import Header from '@/components/Header'
import { OptionsData, Exchange } from '@/types/options'
import { filterExpirations } from '@/lib/filterExpirations'
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'

const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

export default function AnalysisPage() {
  const [exchange, setExchange] = useState<Exchange>('deribit')
  const [selectedCrypto, setSelectedCrypto] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [selectedExpiration, setSelectedExpiration] = useState<string>('')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState<number>(0)
  const [loading, setLoading] = useState(false)
  const [analysisData, setAnalysisData] = useState<{
    sviFits: Record<string, { params: { a: number; b: number; rho: number; m: number; sigma: number }; rmse: number; T: number } | null>
    termStructure: Array<{ label: string; dte: number; atmIV: number; exp: string }>
    skewData: Array<{ label: string; rr: number; bf: number; exp: string }>
    rawSurface: {
      expiries: Array<{ exp: string; label: string; dte: number }>
      buckets: Array<{ key: number; label: string; moneynessPct: number }>
      cells: Array<{
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
      }>
    }
  } | null>(null)
  const [activeSurfaceCell, setActiveSurfaceCell] = useState<{
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
  } | null>(null)
  const fetchVersion = useRef(0)
  const selectedExpirationRef = useRef('')

  useEffect(() => {
    fetchVersion.current++
    const version = fetchVersion.current
    setLoading(true)
    setOptionsData(null)
    setSelectedExpiration('')
    selectedExpirationRef.current = ''

    const coin = (ex: Exchange) => ex === 'okx' ? OKX_FAMILY_MAP[selectedCrypto] : selectedCrypto
    const evtSource = new EventSource(`http://localhost:3500/api/stream/${exchange}/${coin(exchange)}`)

    evtSource.onmessage = (e) => {
      if (version !== fetchVersion.current) { evtSource.close(); return }
      try {
        const data = JSON.parse(e.data)
        if (!data || data.error || !data.data) return
        setOptionsData(prev => {
          if (!prev) return data
          const mergedData = { ...prev.data }
          for (const [exp, chain] of Object.entries(data.data as Record<string, { calls: any[]; puts: any[] }>)) {
            if (prev.data[exp]) {
              const mergeIV = (prev: any, next: any) => ({
                ...prev, ...next,
                markVol: next.markVol || prev?.markVol,
                bidVol:  next.bidVol  || prev?.bidVol,
                askVol:  next.askVol  || prev?.askVol,
              })
              const callMap = new Map(prev.data[exp].calls.map((c: any) => [c.strike, c]))
              for (const c of chain.calls) callMap.set(c.strike, mergeIV(callMap.get(c.strike), c))
              const putMap = new Map(prev.data[exp].puts.map((p: any) => [p.strike, p]))
              for (const p of chain.puts) putMap.set(p.strike, mergeIV(putMap.get(p.strike), p))
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
        setLoading(false)
        if (data.expirations?.length > 0 && !selectedExpirationRef.current) {
          const first = filterExpirations(data.expirations)[0] ?? data.expirations[0]
          setSelectedExpiration(first)
          selectedExpirationRef.current = first
        }
      } catch {}
    }

    evtSource.onerror = () => { if (version !== fetchVersion.current) evtSource.close() }
    return () => evtSource.close()
  }, [selectedCrypto, exchange])

  useEffect(() => {
    const coinParam = exchange === 'okx' ? OKX_FAMILY_MAP[selectedCrypto] : selectedCrypto
    let cancelled = false
    const fetchAnalysis = () => {
      fetch(`http://localhost:3500/api/analysis/${exchange}/${coinParam}`)
        .then(r => r.json())
        .then(d => {
          if (!cancelled && d && !d.error) setAnalysisData(d)
        })
        .catch(() => {})
    }
    fetchAnalysis()
    const id = setInterval(fetchAnalysis, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [exchange, selectedCrypto])

  useEffect(() => {
    setActiveSurfaceCell(null)
  }, [analysisData?.rawSurface])

  const handleExchangeChange = (ex: Exchange) => {
    fetchVersion.current++
    setExchange(ex)
    setOptionsData(null)
    setSelectedExpiration('')
    selectedExpirationRef.current = ''
    setAnalysisData(null)
  }

  const expirations = useMemo(
    () => filterExpirations(optionsData?.expirations ?? []),
    [optionsData]
  )

  const termStructure = analysisData?.termStructure ?? []
  const skewData = analysisData?.skewData ?? []
  const rawSurface = analysisData?.rawSurface ?? null

  // Smile chart data: raw scatter + fitted SVI curve, merged into one array
  const smileChartData = useMemo(() => {
    if (!selectedExpiration || !optionsData || !spotPrice) return []
    const chain = optionsData.data[selectedExpiration]
    if (!chain) return []

    const fitData = analysisData?.sviFits?.[selectedExpiration] ?? null
    const T = fitData?.T ?? Math.max(1e-4, (new Date(selectedExpiration + 'T08:00:00Z').getTime() - Date.now()) / MS_PER_YEAR)

    // Collect OTM raw IV points (standard: calls above spot, puts below spot)
    const rawMap = new Map<number, { markIV: number; bidIV: number | null; askIV: number | null }>()
    for (const c of chain.calls) {
      const mv = c.markVol ?? 0
      if (c.strike >= spotPrice && mv > 0)
        rawMap.set(c.strike, { markIV: mv * 100, bidIV: c.bidVol ? c.bidVol * 100 : null, askIV: c.askVol ? c.askVol * 100 : null })
    }
    for (const p of chain.puts) {
      const mv = p.markVol ?? 0
      if (p.strike <= spotPrice && mv > 0 && !rawMap.has(p.strike))
        rawMap.set(p.strike, { markIV: mv * 100, bidIV: p.bidVol ? p.bidVol * 100 : null, askIV: p.askVol ? p.askVol * 100 : null })
    }
    const rawPoints = Array.from(rawMap.entries())
      .map(([strike, v]) => ({ strike, ...v }))
      .sort((a, b) => a.strike - b.strike)

    type Point = { x: number; mark: number | null; bid: number | null; ask: number | null; fitted: number | null }

    if (!fitData) {
      return rawPoints.map(p => ({ x: p.strike, mark: p.markIV, bid: p.bidIV, ask: p.askIV, fitted: null })) as Point[]
    }

    const logMoneys = rawPoints.map(p => Math.log(p.strike / spotPrice))
    const kMin = Math.min(...logMoneys) - 0.05
    const kMax = Math.max(...logMoneys) + 0.05
    const nPoints = 120
    const { a, b, rho, m, sigma } = fitData.params
    const curve: Point[] = Array.from({ length: nPoints }, (_, i) => {
      const k = kMin + (kMax - kMin) * i / (nPoints - 1)
      const d = k - m
      const w = a + b * (rho * d + Math.sqrt(d * d + sigma * sigma))
      const iv = w > 0 ? Math.sqrt(w / T) * 100 : 0
      return { x: spotPrice * Math.exp(k), mark: null, bid: null, ask: null, fitted: iv > 0 && iv < 500 ? iv : null }
    }).filter(p => p.fitted !== null)

    return [
      ...curve,
      ...rawPoints.map(p => ({ x: p.strike, mark: p.markIV, bid: p.bidIV, ask: p.askIV, fitted: null })),
    ].sort((a, b) => a.x - b.x)
  }, [selectedExpiration, optionsData, spotPrice, analysisData])

  const selectedFit = selectedExpiration ? (analysisData?.sviFits?.[selectedExpiration] ?? null) : null
  const fmtExpiry = (exp: string) =>
    new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const hasIVData = smileChartData.some(d => d.mark !== null)
  const surfaceCells = rawSurface?.cells ?? []
  const surfaceMinIV = surfaceCells.length ? Math.min(...surfaceCells.map(cell => cell.avgMarkIV)) : 0
  const surfaceMaxIV = surfaceCells.length ? Math.max(...surfaceCells.map(cell => cell.avgMarkIV)) : 0
  const activeSurfaceDetails = activeSurfaceCell ?? surfaceCells[0] ?? null

  const surfaceCellMap = useMemo(() => {
    const map = new Map<string, (typeof surfaceCells)[number]>()
    for (const cell of surfaceCells) {
      map.set(`${cell.bucketKey}|${cell.exp}`, cell)
    }
    return map
  }, [surfaceCells])

  const colorForSurfaceCell = (iv: number) => {
    if (surfaceMaxIV <= surfaceMinIV) return 'rgba(59, 130, 246, 0.28)'

    const ratio = Math.max(0, Math.min(1, (iv - surfaceMinIV) / (surfaceMaxIV - surfaceMinIV)))
    const hue = 212 - ratio * 164
    const lightness = 92 - ratio * 42
    return `hsl(${hue.toFixed(0)} 78% ${lightness.toFixed(0)}%)`
  }

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={exchange} onExchangeChange={handleExchangeChange} />

      <main className="container mx-auto px-4 py-4 space-y-4">

        {/* Coin + Expiry selectors */}
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex gap-1 flex-shrink-0">
            {(['BTC', 'ETH', 'SOL'] as const).map(c => (
              <button
                key={c}
                onClick={() => {
                  setSelectedCrypto(c)
                  setOptionsData(null)
                  setSelectedExpiration('')
                  selectedExpirationRef.current = ''
                  setAnalysisData(null)
                }}
                className={classNames('px-3 py-1 rounded text-xs font-medium transition-colors border', {
                  'bg-tone text-white border-tone': selectedCrypto === c,
                  'text-ink-2 border-rim hover:text-ink hover:border-ink-3': selectedCrypto !== c,
                })}
              >{c}</button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 flex-1 min-w-0">
            {expirations.map(exp => (
              <button
                key={exp}
                onClick={() => { selectedExpirationRef.current = exp; setSelectedExpiration(exp) }}
                className={classNames('px-2 py-0.5 rounded text-[10px] font-mono border transition-colors', {
                  'bg-tone text-white border-tone': selectedExpiration === exp,
                  'text-ink-2 border-rim hover:border-ink-3 hover:text-ink': selectedExpiration !== exp,
                })}
              >{fmtExpiry(exp)}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="card flex items-center justify-center h-64">
            <p className="text-ink-2 text-sm">Loading…</p>
          </div>
        ) : (
          <>
            {/* IV Smile */}
            <div className="card">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-ink">
                    IV Smile — {selectedExpiration ? fmtExpiry(selectedExpiration) : '—'}
                  </h2>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {selectedFit
                      ? `SVI fitted curve · RMSE ${(selectedFit.rmse * 100).toFixed(4)}`
                      : hasIVData
                        ? 'Raw mark IV · SVI fit requires ≥5 data points'
                        : 'No IV data — use Deribit, OKX, or Combined'}
                  </p>
                </div>
                {selectedFit && (
                  <div className="flex gap-3 text-[11px] font-mono text-ink-3 flex-shrink-0">
                    <span title="Skew correlation">ρ = {selectedFit.params.rho.toFixed(3)}</span>
                    <span title="Wing slope">b = {selectedFit.params.b.toFixed(4)}</span>
                    <span title="Curvature">σ = {selectedFit.params.sigma.toFixed(4)}</span>
                    <span title="ATM shift">m = {selectedFit.params.m.toFixed(4)}</span>
                  </div>
                )}
              </div>

              {!hasIVData && !loading ? (
                <div className="flex items-center justify-center h-64 text-sm text-ink-3">
                  No IV data — switch to Deribit, OKX, or Combined
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={smileChartData} margin={{ top: 5, right: 24, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                    <XAxis
                      dataKey="x"
                      type="number"
                      scale="linear"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                      tick={{ fontSize: 11 }}
                      label={{ value: 'Strike', position: 'insideBottom', offset: -10, fontSize: 11 }}
                    />
                    <YAxis
                      tickFormatter={v => `${Number(v).toFixed(0)}%`}
                      tick={{ fontSize: 11 }}
                      width={44}
                      label={{ value: 'IV', angle: -90, position: 'insideLeft', offset: 10, fontSize: 11 }}
                    />
                    <Tooltip
                      formatter={(v: any, name: string) => [`${parseFloat(v).toFixed(2)}%`, name]}
                      labelFormatter={v => `Strike: ${Number(v).toLocaleString()}`}
                      contentStyle={{ fontSize: 11 }}
                    />
                    <ReferenceLine
                      x={spotPrice}
                      stroke="var(--color-tone, #f59e0b)"
                      strokeDasharray="4 2"
                      strokeWidth={1.5}
                      label={{ value: 'Spot', position: 'top', fontSize: 10 }}
                    />
                    {/* SVI fitted curve */}
                    <Line dataKey="fitted" name="SVI Fit" connectNulls dot={false}
                      strokeWidth={2} stroke="#8b5cf6" isAnimationActive={false} />
                    {/* Bid/Ask spread as faint dots */}
                    <Line dataKey="bid" name="Bid IV" connectNulls={false} strokeWidth={0}
                      dot={{ r: 3, fill: '#d1d5db', stroke: '#9ca3af', strokeWidth: 1 }} activeDot={{ r: 4 }}
                      isAnimationActive={false} />
                    <Line dataKey="ask" name="Ask IV" connectNulls={false} strokeWidth={0}
                      dot={{ r: 3, fill: '#d1d5db', stroke: '#9ca3af', strokeWidth: 1 }} activeDot={{ r: 4 }}
                      isAnimationActive={false} />
                    {/* Mark IV as solid dots */}
                    <Line dataKey="mark" name="Mark IV" connectNulls={false} strokeWidth={0}
                      dot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 1.5 }} activeDot={{ r: 6 }}
                      isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Term Structure + Skew side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* ATM IV Term Structure */}
              <div className="card">
                <h2 className="text-sm font-semibold text-ink mb-0.5">ATM IV Term Structure</h2>
                <p className="text-xs text-ink-3 mb-4">
                  SVI ATM implied volatility at k=0 across expiries
                </p>
                {termStructure.length < 2 ? (
                  <div className="flex items-center justify-center h-48 text-sm text-ink-3">
                    Need at least 2 expiries with data
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={termStructure} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis
                        tickFormatter={v => `${Number(v).toFixed(0)}%`}
                        tick={{ fontSize: 11 }}
                        width={40}
                      />
                      <Tooltip
                        formatter={(v: any) => [`${parseFloat(v).toFixed(1)}%`, 'ATM IV']}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Line
                        dataKey="atmIV" name="ATM IV"
                        stroke="#8b5cf6" strokeWidth={2}
                        dot={{ r: 4, fill: '#8b5cf6', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* 25Δ Skew & Butterfly */}
              <div className="card">
                <h2 className="text-sm font-semibold text-ink mb-0.5">25Δ Skew &amp; Butterfly</h2>
                <p className="text-xs text-ink-3 mb-4">
                  Risk reversal = call₂₅ − put₂₅ · Fly = (call₂₅ + put₂₅)/2 − ATM · requires Greeks
                </p>
                {skewData.length === 0 ? (
                  <div className="flex items-center justify-center h-48 text-sm text-ink-3">
                    Delta data required — use Deribit, OKX, or Combined
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={skewData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rim, #e5e7eb)" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis
                        tickFormatter={v => `${Number(v).toFixed(1)}%`}
                        tick={{ fontSize: 11 }}
                        width={40}
                      />
                      <Tooltip
                        formatter={(v: any, name: string) => [`${parseFloat(v).toFixed(2)}%`, name]}
                        contentStyle={{ fontSize: 11 }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <ReferenceLine y={0} stroke="var(--color-rim, #e5e7eb)" />
                      <Bar dataKey="rr" name="25Δ RR" fill="#38bdf8" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="bf" name="25Δ Fly" fill="#34d399" radius={[2, 2, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

            </div>

            <div className="card">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-ink">Raw IV Surface</h2>
                  <p className="text-xs text-ink-3 mt-0.5">
                    OTM mark IV bucketed by moneyness in the backend
                  </p>
                </div>
                {activeSurfaceDetails && (
                  <div className="text-[11px] text-ink-3 text-right">
                    <div className="font-medium text-ink">
                      {activeSurfaceDetails.label} · {activeSurfaceDetails.bucketLabel}
                    </div>
                    <div>
                      {activeSurfaceDetails.avgMarkIV.toFixed(1)}% IV · {activeSurfaceDetails.count} contract{activeSurfaceDetails.count === 1 ? '' : 's'}
                    </div>
                    <div>
                      Strikes {activeSurfaceDetails.minStrike.toLocaleString()}-{activeSurfaceDetails.maxStrike.toLocaleString()}
                    </div>
                  </div>
                )}
              </div>

              {!rawSurface || rawSurface.expiries.length === 0 || rawSurface.buckets.length === 0 || rawSurface.cells.length === 0 ? (
                <div className="flex items-center justify-center h-56 text-sm text-ink-3">
                  No raw IV surface data available
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="overflow-x-auto">
                    <div
                      className="grid gap-1 min-w-[640px]"
                      style={{ gridTemplateColumns: `88px repeat(${rawSurface.expiries.length}, minmax(40px, 1fr))` }}
                    >
                      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-3 px-2 py-1">
                        Mny
                      </div>
                      {rawSurface.expiries.map(expiry => (
                        <div key={expiry.exp} className="px-1 py-1 text-center">
                          <div className="text-[11px] font-medium text-ink">{expiry.label}</div>
                          <div className="text-[10px] text-ink-3">{expiry.dte}d</div>
                        </div>
                      ))}

                      {rawSurface.buckets.slice().reverse().map(bucket => (
                        <div
                          key={`row-${bucket.key}`}
                          className="contents"
                        >
                          <div
                            className="flex items-center justify-end pr-2 text-[11px] text-ink-3"
                          >
                            {bucket.label}
                          </div>
                          {rawSurface.expiries.map(expiry => {
                            const cell = surfaceCellMap.get(`${bucket.key}|${expiry.exp}`) ?? null
                            return (
                              <button
                                key={`${bucket.key}-${expiry.exp}`}
                                type="button"
                                onMouseEnter={() => cell && setActiveSurfaceCell(cell)}
                                onFocus={() => cell && setActiveSurfaceCell(cell)}
                                className="h-8 rounded border transition-colors"
                                style={{
                                  backgroundColor: cell ? colorForSurfaceCell(cell.avgMarkIV) : 'rgba(148, 163, 184, 0.08)',
                                  borderColor: cell ? 'rgba(255, 255, 255, 0.18)' : 'rgba(148, 163, 184, 0.12)',
                                }}
                                aria-label={cell
                                  ? `${expiry.label} ${bucket.label} ${cell.avgMarkIV.toFixed(1)} percent implied volatility`
                                  : `${expiry.label} ${bucket.label} no data`}
                                title={cell
                                  ? `${expiry.label} · ${bucket.label} · ${cell.avgMarkIV.toFixed(1)}% IV · ${cell.count} contract${cell.count === 1 ? '' : 's'}`
                                  : `${expiry.label} · ${bucket.label} · no data`}
                              >
                                <span className="sr-only">
                                  {cell ? `${cell.avgMarkIV.toFixed(1)}% IV` : 'No data'}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 text-[11px] text-ink-3">
                    <div>
                      Hover a cell to inspect expiry, moneyness, IV, and strike range.
                    </div>
                    <div className="flex items-center gap-2">
                      <span>{surfaceMinIV.toFixed(1)}%</span>
                      <div
                        className="h-2 w-28 rounded-full"
                        style={{ background: 'linear-gradient(90deg, hsl(212 78% 92%), hsl(48 78% 72%), hsl(18 78% 50%))' }}
                      />
                      <span>{surfaceMaxIV.toFixed(1)}%</span>
                    </div>
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
