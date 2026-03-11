'use client'

import { useMemo, useState, useEffect } from 'react'
import classNames from 'classnames'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Legend
} from 'recharts'
import { Leg } from '@/types/options'
import { bsPrice, bsGreeks, findBreakevens, Greeks } from '@/lib/blackScholes'
import { useTheme } from '@/components/ThemeProvider'

interface PnLChartProps {
  legs: Leg[]
  spotPrice: number
}

const PRICE_POINTS = 120

const TAKER_FEE = 0.0003
const FEE_CAP: Record<string, number> = { bybit: 0.07, okx: 0.07, deribit: 0.125 }

function legFeeUSD(leg: Leg, spotPrice: number): number {
  if (leg.contractSize <= 0 || leg.qty <= 0) return 0
  const cap = FEE_CAP[leg.exchange as string] ?? 0.07
  // entryPrice is per-BTC-underlying USD; fee is capped per-BTC then scaled to per-contract
  return Math.min(TAKER_FEE * spotPrice, cap * leg.entryPrice) * leg.contractSize * leg.qty
}

function computePnL(legs: Leg[], prices: number[], sliderDays: number, ivMult: number, feesApplied = false, spotPrice = 0): number[] {
  return prices.map(S => {
    return legs.filter(l => l.enabled).reduce((sum, leg) => {
      const sign = leg.side === 'buy' ? 1 : -1
      const fee  = feesApplied ? legFeeUSD(leg, spotPrice) : 0
      if (leg.type === 'future') {
        // Futures P&L = ±(current_price − entry_price) × qty × contractSize
        const pnl = sign * (S - leg.entryPrice) * leg.qty * leg.contractSize
        return sum + pnl - fee
      }
      const expiryMs = new Date(leg.expiry).getTime()
      const daysToExpiry = Math.max(0, (expiryMs - Date.now()) / 86_400_000)
      const T = Math.max(0, (daysToExpiry - sliderDays) / 365)
      const sigma = Math.max(0.001, leg.markVol * ivMult)
      const value = bsPrice(S, leg.strike, T, sigma, 0, leg.type) * leg.qty * leg.contractSize
      const cost  = leg.entryPrice * leg.contractSize * leg.qty
      return sum + sign * (value - cost) - fee
    }, 0)
  })
}

function computePositionGreeks(legs: Leg[], spot: number, sliderDays: number, ivMult: number): Greeks {
  return legs.filter(l => l.enabled).reduce((acc, leg) => {
    const scale = leg.qty * leg.contractSize * (leg.side === 'buy' ? 1 : -1)
    if (leg.type === 'future') {
      // Futures: delta = ±1, no gamma/theta/vega
      return { delta: acc.delta + scale, gamma: acc.gamma, theta: acc.theta, vega: acc.vega }
    }
    const expiryMs = new Date(leg.expiry).getTime()
    const daysToExpiry = Math.max(0, (expiryMs - Date.now()) / 86_400_000)
    const T = Math.max(0, (daysToExpiry - sliderDays) / 365)
    const sigma = Math.max(0.001, leg.markVol * ivMult)
    const g = bsGreeks(spot, leg.strike, T, sigma, 0, leg.type)
    return {
      delta: acc.delta + g.delta * scale,
      gamma: acc.gamma + g.gamma * scale,
      theta: acc.theta + g.theta * scale,
      vega:  acc.vega  + g.vega  * scale,
    }
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 })
}

const CustomTooltip = ({ active, payload, label, sliderLabel }: any) => {
  if (!active || !payload?.length) return null
  const seen = new Set<string>()
  const entries = payload.filter((p: any) =>
    p.value != null && !seen.has(p.name) && seen.add(p.name)
  )
  const data = payload[0]?.payload
  const hasGreeks = data?.g_delta != null
  return (
    <div className="bg-card border border-rim rounded shadow-sm px-3 py-2 text-xs min-w-[170px]">
      <div className="font-mono text-ink mb-1">${Number(label).toLocaleString()}</div>
      {entries.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-semibold">{p.value >= 0 ? '+' : ''}{p.value.toFixed(0)} USD</span>
        </div>
      ))}
      {hasGreeks && (
        <div className="border-t border-rim mt-1.5 pt-1.5 space-y-0.5">
          <div className="grid grid-cols-2 gap-x-4 font-mono">
            <span className="text-ink-3">Δ <span className={`font-semibold ${data.g_delta >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{data.g_delta >= 0 ? '+' : ''}{data.g_delta.toFixed(4)}</span></span>
            <span className="text-ink-3">Γ <span className="font-semibold text-violet-600 dark:text-violet-400">{data.g_gamma.toFixed(5)}</span></span>
            <span className="text-ink-3">Θ <span className={`font-semibold ${data.g_theta >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{data.g_theta >= 0 ? '+' : ''}{data.g_theta.toFixed(2)}</span></span>
            <span className="text-ink-3">Ψ <span className="font-semibold text-blue-600 dark:text-blue-400">{data.g_vega >= 0 ? '+' : ''}{data.g_vega.toFixed(2)}</span></span>
          </div>
          <div className="text-[9px] text-ink-3">{sliderLabel}</div>
        </div>
      )}
    </div>
  )
}

function computeGreeksProfile(legs: Leg[], prices: number[], sliderDays: number, ivMult: number) {
  return prices.map(S => {
    const g0 = computePositionGreeks(legs, S, 0,          ivMult)
    const gs = computePositionGreeks(legs, S, sliderDays, ivMult)
    return {
      price:   Math.round(S),
      delta0:  parseFloat(g0.delta.toFixed(3)),
      deltaS:  parseFloat(gs.delta.toFixed(3)),
      gamma0:  parseFloat(g0.gamma.toFixed(5)),
      gammaS:  parseFloat(gs.gamma.toFixed(5)),
    }
  })
}

function computeGreeksAtPrice(legs: Leg[], prices: number[], sliderDays: number, ivMult: number) {
  return prices.map(S => {
    const g = computePositionGreeks(legs, S, sliderDays, ivMult)
    return {
      g_delta: parseFloat(g.delta.toFixed(4)),
      g_gamma: parseFloat(g.gamma.toFixed(6)),
      g_theta: parseFloat(g.theta.toFixed(2)),
      g_vega:  parseFloat(g.vega.toFixed(2)),
    }
  })
}

export default function PnLChart({ legs, spotPrice }: PnLChartProps) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const [activeTab, setActiveTab] = useState<'pnl' | 'greeks'>('pnl')
  const [sliderDays, setSliderDays] = useState(0)
  const [ivStress, setIvStress] = useState(0)
  const [rangePercent, setRangePercent] = useState(30)
  const [feesApplied, setFeesApplied] = useState(true)

  const activeLegExpiries = legs.filter(l => l.enabled).map(l => l.expiry)
  const maxDays = activeLegExpiries.length > 0
    ? Math.max(1, Math.max(...activeLegExpiries.map(exp =>
        Math.ceil((new Date(exp).getTime() - Date.now()) / 86_400_000)
      )))
    : 30

  useEffect(() => {
    if (sliderDays > maxDays) setSliderDays(maxDays)
  }, [maxDays])

  const ivMult = 1 + ivStress / 100

  const prices = useMemo(() => {
    if (!spotPrice) return []
    const lo = spotPrice * (1 - rangePercent / 100)
    const hi = spotPrice * (1 + rangePercent / 100)
    return Array.from({ length: PRICE_POINTS }, (_, i) => lo + (hi - lo) * i / (PRICE_POINTS - 1))
  }, [spotPrice, rangePercent])

  const todayPnL    = useMemo(() => computePnL(legs, prices, 0,         ivMult, feesApplied, spotPrice), [legs, prices, ivMult, feesApplied, spotPrice])
  const sliderPnL   = useMemo(() => computePnL(legs, prices, sliderDays, ivMult, feesApplied, spotPrice), [legs, prices, sliderDays, ivMult, feesApplied, spotPrice])
  const expiryPnL   = useMemo(() => computePnL(legs, prices, maxDays,   ivMult, feesApplied, spotPrice), [legs, prices, maxDays, ivMult, feesApplied, spotPrice])
  const greeks         = useMemo(() => computePositionGreeks(legs, spotPrice, sliderDays, ivMult), [legs, spotPrice, sliderDays, ivMult])
  const breakevens     = useMemo(() => findBreakevens(prices, expiryPnL), [prices, expiryPnL])
  const greeksData     = useMemo(() => computeGreeksProfile(legs, prices, sliderDays, ivMult), [legs, prices, sliderDays, ivMult])
  const greeksAtPrice  = useMemo(() => computeGreeksAtPrice(legs, prices, sliderDays, ivMult), [legs, prices, sliderDays, ivMult])

  const chartData = useMemo(() => prices.map((p, i) => {
    const t = parseFloat(todayPnL[i].toFixed(2))
    const s = parseFloat(sliderPnL[i].toFixed(2))
    const e = parseFloat(expiryPnL[i].toFixed(2))
    return {
      price: Math.round(p),
      today_p: t >= 0 ? t : null,
      today_n: t <= 0 ? t : null,
      sel_p:   s >= 0 ? s : null,
      sel_n:   s <= 0 ? s : null,
      exp_p:   e >= 0 ? e : null,
      exp_n:   e <= 0 ? e : null,
      ...greeksAtPrice[i],
    }
  }), [prices, todayPnL, sliderPnL, expiryPnL, greeksAtPrice])

  const sliderDate = new Date(Date.now() + sliderDays * 86_400_000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const expiryDate = new Date(Date.now() + maxDays * 86_400_000)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  // Chart colors adapt to theme
  const gridColor   = isDark ? '#3c3628' : '#f0ece4'
  const axisColor   = isDark ? '#80685a' : '#b0a090'
  const spotColor   = isDark ? '#6b5c4c' : '#94a3b8'
  const zeroColor   = isDark ? '#57483a' : '#cbd5e1'
  const profitFill  = isDark ? '#22c55e' : '#16a34a'
  const lossFill    = isDark ? '#ef4444' : '#dc2626'

  if (legs.length === 0) {
    return (
      <div className="card text-center py-12 text-sm text-ink-3">
        Add legs to see P&L simulation
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">Simulation</h2>
          <div className="flex rounded-md overflow-hidden border border-rim text-xs">
            {(['pnl', 'greeks'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-2 py-0.5 ${activeTab === tab ? 'bg-tone text-white' : 'text-ink-2 hover:bg-muted'}`}>
                {tab === 'pnl' ? 'P&L' : 'Greeks'}
              </button>
            ))}
          </div>
          <button
            onClick={() => setFeesApplied(v => !v)}
            className={classNames('px-2 py-0.5 rounded border text-xs font-medium transition-colors', {
              'bg-tone text-white border-tone': feesApplied,
              'text-ink-2 border-rim hover:border-ink-3': !feesApplied,
            })}
            title={feesApplied ? 'Fees included in P&L (taker fee per leg)' : 'Fees excluded from P&L'}
          >
            Fees {feesApplied ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="flex items-center gap-4 text-xs text-ink-2 flex-wrap">
          <div className="flex items-center gap-1">
            <span>Range</span>
            {[5, 10, 20, 30, 50].map(p => (
              <button key={p} onClick={() => setRangePercent(p)}
                className={classNames('px-1.5 py-0.5 rounded border text-[10px]', {
                  'bg-tone text-white border-tone': rangePercent === p,
                  'text-ink-2 border-rim hover:border-ink-3': rangePercent !== p,
                })}>
                ±{p}%
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <span className="w-8">Date</span>
            <input type="range" min={0} max={maxDays} value={sliderDays}
              onChange={e => setSliderDays(Number(e.target.value))}
              className="w-32 accent-amber-500" />
            <span className="w-20 text-tone font-mono">
              {sliderDays === 0 ? 'Today' : sliderDate}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-4">IV</span>
            <input type="range" min={-80} max={300} value={ivStress}
              onChange={e => setIvStress(Number(e.target.value))}
              className="w-28 accent-amber-500" />
            <span className="w-14 font-mono text-tone">
              {ivStress >= 0 ? '+' : ''}{ivStress}%
            </span>
          </label>
        </div>
      </div>

      {activeTab === 'pnl' ? (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
            <XAxis dataKey="price" tickFormatter={v => `$${(v/1000).toFixed(0)}k`}
              tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} />
            <YAxis tickFormatter={v => `${v >= 0 ? '+' : ''}${Number(v).toFixed(0)}`}
              tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} width={55} />
            <Tooltip content={(props: any) => <CustomTooltip {...props} sliderLabel={sliderDays === 0 ? 'Today' : sliderDate} />} />
            <ReferenceArea y1={0} fill={profitFill} fillOpacity={0.04} />
            <ReferenceArea y2={0} fill={lossFill}   fillOpacity={0.04} />
            <ReferenceLine y={0} stroke={zeroColor} strokeWidth={1.5} />
            <ReferenceLine x={Math.round(spotPrice)} stroke={spotColor} strokeDasharray="3 3"
              label={{ value: 'Spot', position: 'top', fontSize: 9, fill: spotColor }} />
            {breakevens.map((be, i) => (
              <ReferenceLine key={i} x={Math.round(be)} stroke="#f59e0b" strokeDasharray="2 2"
                label={{ value: `BE $${Math.round(be).toLocaleString()}`, position: 'insideTopLeft', fontSize: 9, fill: '#f59e0b' }} />
            ))}
            {/* Today */}
            <Line type="monotone" dataKey="today_p" name="Today"
              stroke="#22c55e" dot={false} strokeWidth={1.5} strokeDasharray="4 3" connectNulls={false} />
            <Line type="monotone" dataKey="today_n" name="Today"
              stroke="#ef4444" dot={false} strokeWidth={1.5} strokeDasharray="4 3" legendType="none" connectNulls={false} />
            {/* Selected */}
            <Line type="monotone" dataKey="sel_p" name={sliderDays === 0 ? 'Today' : sliderDate}
              stroke="#22c55e" dot={false} strokeWidth={2} connectNulls={false} />
            <Line type="monotone" dataKey="sel_n" name={sliderDays === 0 ? 'Today' : sliderDate}
              stroke="#ef4444" dot={false} strokeWidth={2} legendType="none" connectNulls={false} />
            {/* Expiry */}
            <Line type="monotone" dataKey="exp_p" name={`Expiry (${expiryDate})`}
              stroke="#22c55e" dot={false} strokeWidth={1.5} strokeDasharray="2 2" connectNulls={false} />
            <Line type="monotone" dataKey="exp_n" name={`Expiry (${expiryDate})`}
              stroke="#ef4444" dot={false} strokeWidth={1.5} strokeDasharray="2 2" legendType="none" connectNulls={false} />
            <Legend wrapperStyle={{ fontSize: 11, color: axisColor }} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="space-y-1">
          {/* Delta profile */}
          <div className="text-[10px] text-ink-3 pl-14">Delta (Δ)</div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={greeksData} margin={{ top: 2, right: 16, left: 0, bottom: 2 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="price" tickFormatter={v => `$${(v/1000).toFixed(0)}k`}
                tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} />
              <YAxis tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} width={50}
                tickFormatter={v => v.toFixed(2)} />
              <Tooltip formatter={(v: any) => v.toFixed(3)} labelFormatter={v => `$${Number(v).toLocaleString()}`}
                contentStyle={{ fontSize: 11, background: isDark ? '#1e1a12' : '#fff', border: `1px solid ${gridColor}` }} />
              <ReferenceLine y={0} stroke={zeroColor} strokeWidth={1.5} />
              <ReferenceLine x={Math.round(spotPrice)} stroke={spotColor} strokeDasharray="3 3"
                label={{ value: 'Spot', position: 'top', fontSize: 9, fill: spotColor }} />
              <Line type="monotone" dataKey="delta0" name="Today" stroke="#22c55e" dot={false} strokeWidth={1.5} strokeDasharray="4 3" />
              <Line type="monotone" dataKey="deltaS" name={sliderDays === 0 ? 'Today' : sliderDate}
                stroke="#22c55e" dot={false} strokeWidth={2} />
              <Legend wrapperStyle={{ fontSize: 11, color: axisColor }} />
            </LineChart>
          </ResponsiveContainer>
          {/* Gamma profile */}
          <div className="text-[10px] text-ink-3 pl-14">Gamma (Γ)</div>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={greeksData} margin={{ top: 2, right: 16, left: 0, bottom: 2 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="price" tickFormatter={v => `$${(v/1000).toFixed(0)}k`}
                tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} />
              <YAxis tick={{ fontSize: 10, fill: axisColor }} stroke={gridColor} width={50}
                tickFormatter={v => v.toFixed(4)} />
              <Tooltip formatter={(v: any) => v.toFixed(5)} labelFormatter={v => `$${Number(v).toLocaleString()}`}
                contentStyle={{ fontSize: 11, background: isDark ? '#1e1a12' : '#fff', border: `1px solid ${gridColor}` }} />
              <ReferenceLine y={0} stroke={zeroColor} strokeWidth={1.5} />
              <ReferenceLine x={Math.round(spotPrice)} stroke={spotColor} strokeDasharray="3 3" />
              <Line type="monotone" dataKey="gamma0" name="Today" stroke="#a78bfa" dot={false} strokeWidth={1.5} strokeDasharray="4 3" />
              <Line type="monotone" dataKey="gammaS" name={sliderDays === 0 ? 'Today' : sliderDate}
                stroke="#a78bfa" dot={false} strokeWidth={2} />
              <Legend wrapperStyle={{ fontSize: 11, color: axisColor }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-rim grid grid-cols-4 gap-2 text-xs text-center">
        {[
          { label: 'Delta', value: greeks.delta, dp: 3 },
          { label: 'Gamma', value: greeks.gamma, dp: 5 },
          { label: 'Theta', value: greeks.theta, dp: 1 },
          { label: 'Vega',  value: greeks.vega,  dp: 1 },
        ].map(g => (
          <div key={g.label} className="bg-muted rounded p-2">
            <div className="text-ink-2">{g.label}</div>
            <div className={`font-mono font-semibold ${g.value >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {g.value >= 0 ? '+' : ''}{g.value.toFixed(g.dp)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
