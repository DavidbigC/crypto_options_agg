'use client'

import { useState } from 'react'
import classNames from 'classnames'
import { BoxSpread, ArbOpportunity, ArbStrategy } from '@/lib/strategies'
import { EX_BADGE, EX_LABEL } from '@/lib/exchangeColors'

// ── Strategy signifiers ──────────────────────────────────────────────────────

interface StrategyMeta {
  label: string
  bg: string       // tailwind bg class
  text: string     // tailwind text class
  ring: string     // tailwind ring/border class for row highlight
  title: string
  desc: string     // short strategy description for hover card
}

const STRATEGY_META: Record<string, StrategyMeta> = {
  box_long: {
    label: 'LB', bg: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', ring: 'border-l-amber-500',
    title: 'Long Box',
    desc: 'Buy C(K1)+P(K2), sell C(K2)+P(K1). Cost < K2−K1 → collect the difference at expiry. Fully hedged, zero directional risk.',
  },
  box_short: {
    label: 'SB', bg: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-300', ring: 'border-l-orange-500',
    title: 'Short Box',
    desc: 'Sell C(K1)+P(K2), buy C(K2)+P(K1). Premium received > K2−K1 → keep the difference. Fully hedged, zero directional risk.',
  },
  call_monotonicity: {
    label: 'C≥', bg: 'bg-emerald-600', text: 'text-emerald-700 dark:text-emerald-300', ring: 'border-l-emerald-500',
    title: 'Call Monotonicity',
    desc: 'A lower-strike call costs less than a higher-strike call — violates C(K1) ≥ C(K2). Buy cheap K1, sell expensive K2 for instant credit.',
  },
  put_monotonicity: {
    label: 'P≥', bg: 'bg-rose-600', text: 'text-rose-700 dark:text-rose-300', ring: 'border-l-rose-500',
    title: 'Put Monotonicity',
    desc: 'A higher-strike put costs less than a lower-strike put — violates P(K2) ≥ P(K1). Sell cheap K1 put, buy expensive K2 put for instant credit.',
  },
  call_butterfly: {
    label: 'C◆', bg: 'bg-violet-600', text: 'text-violet-700 dark:text-violet-300', ring: 'border-l-violet-500',
    title: 'Call Butterfly',
    desc: 'Sell 2× middle call, buy 1× each wing (equal spacing). Net credit upfront — at expiry payoff is always ≥ 0. Max loss = wing width.',
  },
  put_butterfly: {
    label: 'P◆', bg: 'bg-purple-600', text: 'text-purple-700 dark:text-purple-300', ring: 'border-l-purple-500',
    title: 'Put Butterfly',
    desc: 'Sell 2× middle put, buy 1× each wing (equal spacing). Net credit upfront — at expiry payoff is always ≥ 0. Max loss = wing width.',
  },
  calendar_arb: {
    label: 'CAL', bg: 'bg-sky-600', text: 'text-sky-700 dark:text-sky-300', ring: 'border-l-sky-500',
    title: 'Calendar Arb',
    desc: 'Near-term bid > far-term ask at same strike. Longer-dated options can\'t be worth less — sell near, buy far for free premium.',
  },
  pcp_conversion: {
    label: 'CVT', bg: 'bg-teal-600', text: 'text-teal-700 dark:text-teal-300', ring: 'border-l-teal-500',
    title: 'Conversion',
    desc: 'Sell call + buy put at K. Synthetic short forward priced above F−K. Pocket the excess; hedge with a perp/futures buy at F.',
  },
  pcp_reversal: {
    label: 'REV', bg: 'bg-cyan-600', text: 'text-cyan-700 dark:text-cyan-300', ring: 'border-l-cyan-500',
    title: 'Reversal',
    desc: 'Buy call + sell put at K. Synthetic long forward priced below F−K. Pocket the gap; hedge with a perp/futures sell at F.',
  },
}

// ── Exchange badges ──────────────────────────────────────────────────────────


// ── Normalised display shape ─────────────────────────────────────────────────

interface DisplayLeg {
  action: 'buy' | 'sell'
  type: 'call' | 'put' | 'future'
  strike: number
  expiry: string
  qty: number
  price: number
  exchange: string | null
}

interface DisplayOpp {
  strategyKey: string
  meta: StrategyMeta
  expiry: string
  description: string
  legs: DisplayLeg[]
  profit: number
  apr: number
  collateral: number
  boxSummary?: string   // only for box spreads
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function normalizeBox(b: BoxSpread): DisplayOpp {
  const strategyKey = b.type === 'long' ? 'box_long' : 'box_short'
  const days = Math.max(1, (new Date(b.expiry).getTime() - Date.now()) / 86_400_000)
  const collateral = b.type === 'long' ? b.cost : b.boxValue
  const apr = collateral > 0 ? (b.profit / collateral) * (365 / days) * 100 : 0
  return {
    strategyKey,
    meta: STRATEGY_META[strategyKey],
    expiry: b.expiry,
    description: `${b.k1.toLocaleString()} / ${b.k2.toLocaleString()} · box $${b.boxValue.toLocaleString()} · ${Math.ceil(days)}d`,
    legs: b.legs.map(l => ({ ...l, expiry: b.expiry, qty: 1 })),
    profit: b.profit,
    apr,
    collateral,
    boxSummary: b.type === 'long'
      ? `Pay $${b.cost.toFixed(0)} · collect $${b.boxValue.toLocaleString()} at expiry`
      : `Receive $${b.cost.toFixed(0)} · pay $${b.boxValue.toLocaleString()} at expiry`,
  }
}

function normalizeArb(a: ArbOpportunity): DisplayOpp {
  const meta = STRATEGY_META[a.strategy]
  const days = Math.max(1, (new Date(a.expiry).getTime() - Date.now()) / 86_400_000)

  let description = ''
  if (a.strategy === 'call_monotonicity' || a.strategy === 'put_monotonicity') {
    const type = a.strategy === 'call_monotonicity' ? 'C' : 'P'
    description = `${type} ${a.legs[0].strike.toLocaleString()} / ${a.legs[1].strike.toLocaleString()} · ${Math.ceil(days)}d`
  } else if (a.strategy === 'call_butterfly' || a.strategy === 'put_butterfly') {
    const type = a.strategy === 'call_butterfly' ? 'C' : 'P'
    description = `${type} ${a.legs[0].strike.toLocaleString()} / ${a.legs[1].strike.toLocaleString()} / ${a.legs[2].strike.toLocaleString()} · ${Math.ceil(days)}d`
  } else if (a.strategy === 'calendar_arb') {
    const l = a.legs
    description = `${l[0].type === 'call' ? 'C' : 'P'} ${l[0].strike.toLocaleString()} · ${fmtDate(l[0].expiry)} → ${fmtDate(l[1].expiry)}`
  } else if (a.strategy === 'pcp_conversion' || a.strategy === 'pcp_reversal') {
    const dir = a.strategy === 'pcp_conversion' ? 'Sell C / Buy P' : 'Buy C / Sell P'
    description = `K ${a.legs[0].strike.toLocaleString()} · ${dir} · ${Math.ceil(days)}d`
  }

  const boxSummary = (a.strategy === 'pcp_conversion' || a.strategy === 'pcp_reversal')
    ? 'Futures hedge at fwd price auto-added in builder · delta = 0 when hedged'
    : undefined

  return {
    strategyKey: a.strategy,
    meta,
    expiry: a.expiry,
    description,
    legs: a.legs,
    profit: a.profit,
    apr: a.apr,
    collateral: a.collateral,
    boxSummary,
  }
}

// ── Practical collateral ─────────────────────────────────────────────────────

interface ExBreakdown {
  ex: string
  shorts: DisplayLeg[]
  longs: DisplayLeg[]
  margin: number   // shorts: ~10% spot + mark; longs: premium paid
}

interface PracticalInfo {
  isSameExchange: boolean
  singleExchange: string | null
  byExchange: ExBreakdown[]
  total: number
  apr: number
}

function calcPractical(opp: DisplayOpp, spotPrice: number): PracticalInfo {
  const days = Math.max(1, (new Date(opp.expiry).getTime() - Date.now()) / 86_400_000)

  const map = new Map<string, ExBreakdown>()
  for (const leg of opp.legs) {
    const ex = leg.exchange ?? 'unknown'
    if (!map.has(ex)) map.set(ex, { ex, shorts: [], longs: [], margin: 0 })
    const e = map.get(ex)!
    if (leg.action === 'sell') {
      e.shorts.push(leg)
      // Short option margin: ~10% of spot notional + mark price (standard crypto exchange approx)
      e.margin += (0.1 * spotPrice + leg.price) * leg.qty
    } else {
      e.longs.push(leg)
      e.margin += leg.price * leg.qty   // capital deployed (premium paid)
    }
  }

  const byExchange = Array.from(map.values())
  const isSameExchange = byExchange.length === 1
  const singleExchange = isSameExchange ? byExchange[0].ex : null

  // Same-exchange: spread recognised, use theoretical collateral
  // Cross-exchange: each exchange margins its legs in isolation
  const total = isSameExchange
    ? opp.collateral
    : byExchange.reduce((s, e) => s + e.margin, 0)

  const apr = total > 0 ? (opp.profit / total) * (365 / days) * 100 : 0
  return { isSameExchange, singleExchange, byExchange, total, apr }
}

// ── Component ────────────────────────────────────────────────────────────────

interface ArbPanelProps {
  boxSpreads: BoxSpread[]
  arbs: ArbOpportunity[]
  expiration: string
  coin: string
  spotPrice: number
}

export default function ArbPanel({ boxSpreads, arbs, expiration, coin, spotPrice }: ArbPanelProps) {
  const [isOpen, setIsOpen] = useState(true)

  const sendToBuilder = (opp: DisplayOpp) => {
    localStorage.setItem('arb_pending_strategy', JSON.stringify({ coin, legs: opp.legs }))
    window.open('/builder', '_blank')
  }

  const all: DisplayOpp[] = [
    ...boxSpreads.map(normalizeBox),
    ...arbs.map(normalizeArb),
  ].sort((a, b) => b.profit - a.profit)

  if (all.length === 0) return null

  return (
    <div className="surface-band px-5 py-5">
      <button
        onClick={() => setIsOpen(v => !v)}
        className="flex items-center gap-3 w-full text-left mb-0 group"
      >
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Contextual opportunities</div>
          <h2 className="heading-serif mt-1 text-2xl font-semibold text-ink">Arbitrage ledger</h2>
        </div>
        <span className="text-sm text-ink-2">
          {fmtDate(expiration)} · {all.length} found · fees included
        </span>
        {/* Legend — only when open */}
        {isOpen && (
          <div className="flex items-center gap-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
            {Object.entries(STRATEGY_META).map(([key, m]) => (
              <div key={key} className="relative group/legend">
                <span className={classNames('text-[9px] text-white rounded px-1 py-0.5 font-bold cursor-help', m.bg)}>
                  {m.label}
                </span>
                <div className="absolute right-0 bottom-full mb-2 w-64 bg-card border border-rim rounded-lg p-2.5 text-[10px] hidden group-hover/legend:block z-50 shadow-xl pointer-events-none">
                  <div className={classNames('font-bold mb-1', m.text)}>{m.title}</div>
                  <div className="text-ink-2 leading-relaxed">{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <span className="ml-auto text-ink-3 text-xs group-hover:text-ink transition-colors">
          {isOpen ? '▲' : '▼'}
        </span>
      </button>

      {isOpen && <div className="space-y-1.5 mt-3">
        {all.map((opp, i) => (
          <div
            key={i}
            className={classNames(
              'border border-rim rounded p-2.5 text-xs border-l-2',
              opp.meta.ring,
            )}
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="relative group/badge flex-shrink-0">
                  <span className={classNames('text-[9px] text-white rounded px-1 py-0.5 font-bold cursor-help', opp.meta.bg)}>
                    {opp.meta.label}
                  </span>
                  <div className="absolute left-0 bottom-full mb-2 w-64 bg-card border border-rim rounded-lg p-2.5 text-[10px] hidden group-hover/badge:block z-50 shadow-xl pointer-events-none">
                    <div className={classNames('font-bold mb-1', opp.meta.text)}>{opp.meta.title}</div>
                    <div className="text-ink-2 leading-relaxed">{opp.meta.desc}</div>
                  </div>
                </div>
                <span className="font-medium text-ink">{opp.meta.title}</span>
                <span className="font-mono text-ink-3">{opp.description}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className={classNames('font-mono font-bold', opp.meta.text)}>
                  +${opp.profit.toFixed(0)}
                </span>
                {/* APR with hover tooltip */}
                {(() => {
                  const p = calcPractical(opp, spotPrice)
                  return (
                    <div className="relative group/apr">
                      <span className={classNames('font-mono font-semibold text-[11px] cursor-help inline-flex items-center gap-1', opp.meta.text)}>
                        {opp.apr.toFixed(1)}% APR
                        <span className={classNames('w-1.5 h-1.5 rounded-full inline-block flex-shrink-0', p.isSameExchange ? 'bg-green-500' : 'bg-yellow-500')} />
                      </span>
                      {/* Tooltip */}
                      <div className="absolute right-0 bottom-full mb-2 w-72 bg-card border border-rim rounded-lg p-2.5 text-[10px] hidden group-hover/apr:block z-50 shadow-xl pointer-events-none">
                        {p.isSameExchange ? (
                          <>
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                              <span className="font-semibold text-ink">Same-exchange spread</span>
                            </div>
                            <div className="text-ink-2 mb-1">
                              All legs on <span className="font-medium text-ink uppercase">{p.singleExchange}</span> — exchange recognises the spread and applies spread margin.
                            </div>
                            <div className="border-t border-rim pt-1.5 mt-1.5 flex justify-between">
                              <span className="text-ink-3">Spread margin (max loss)</span>
                              <span className="font-mono text-ink">${opp.collateral.toFixed(0)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-ink-3">Theoretical APR</span>
                              <span className={classNames('font-mono font-semibold', opp.meta.text)}>{opp.apr.toFixed(1)}%</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5 mb-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 flex-shrink-0" />
                              <span className="font-semibold text-ink">Cross-exchange</span>
                            </div>
                            <div className="text-ink-3 mb-2">Each exchange only sees its own legs and margins them independently.</div>
                            {p.byExchange.map(e => (
                              <div key={e.ex} className="mb-1.5">
                                <div className="flex items-center gap-1 mb-0.5">
                                  <span className={classNames('text-[8px] text-white rounded px-0.5 font-bold', EX_BADGE[e.ex] ?? 'bg-zinc-500')}>{EX_LABEL[e.ex] ?? e.ex}</span>
                                  <span className="font-semibold text-ink">${e.margin.toFixed(0)}</span>
                                </div>
                                {e.shorts.map((l, k) => (
                                  <div key={k} className="text-ink-3 pl-2">
                                    SELL {l.qty > 1 ? `×${l.qty} ` : ''}{l.type === 'call' ? 'C' : 'P'} {l.strike.toLocaleString()} → ~${((0.1 * spotPrice + l.price) * l.qty).toFixed(0)} margin
                                  </div>
                                ))}
                                {e.longs.map((l, k) => (
                                  <div key={k} className="text-ink-3 pl-2">
                                    BUY {l.type === 'call' ? 'C' : 'P'} {l.strike.toLocaleString()} → ${(l.price * l.qty).toFixed(0)} premium
                                  </div>
                                ))}
                              </div>
                            ))}
                            <div className="border-t border-rim pt-1.5 mt-0.5 space-y-0.5">
                              <div className="flex justify-between">
                                <span className="text-ink-3">Total practical collateral</span>
                                <span className="font-mono text-ink">${p.total.toFixed(0)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-ink-3">Practical APR</span>
                                <span className={classNames('font-mono font-semibold', opp.meta.text)}>{p.apr.toFixed(1)}%</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-ink-3">Theoretical APR (spread width)</span>
                                <span className="font-mono text-ink-2">{opp.apr.toFixed(1)}%</span>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })()}
                <button
                  onClick={() => sendToBuilder(opp)}
                  title="Send to Position Builder"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-rim text-ink-2 hover:text-ink hover:border-ink-3 transition-colors"
                >
                  → Builder
                </button>
              </div>
            </div>

            {/* Legs (options only — futures hedge leg handled by builder) */}
            <div className="grid grid-cols-2 gap-1">
              {opp.legs.filter(leg => leg.type !== 'future').map((leg, j) => (
                <div key={j} className="flex items-center gap-1.5 bg-muted rounded px-2 py-0.5">
                  <span className={classNames('w-7 text-center rounded text-[9px] font-bold px-0.5 flex-shrink-0', {
                    'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400': leg.action === 'buy',
                    'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400':   leg.action === 'sell',
                  })}>
                    {leg.action === 'buy' ? 'BUY' : 'SELL'}
                  </span>
                  {leg.qty > 1 && (
                    <span className="text-[9px] text-ink-3 font-mono flex-shrink-0">×{leg.qty}</span>
                  )}
                  <span className={classNames('text-[10px] font-semibold w-3 flex-shrink-0', {
                    'text-green-700 dark:text-green-400': leg.type === 'call',
                    'text-red-600 dark:text-red-400':     leg.type === 'put',
                  })}>
                    {leg.type === 'call' ? 'C' : 'P'}
                  </span>
                  <span className="font-mono text-ink text-[11px]">{leg.strike.toLocaleString()}</span>
                  {/* Show expiry only for calendar arb (legs have different dates) */}
                  {opp.strategyKey === 'calendar_arb' && (
                    <span className="text-[9px] text-ink-3 font-mono">{fmtDate(leg.expiry)}</span>
                  )}
                  <span className="font-mono text-ink-2 ml-auto text-[11px]">${leg.price.toFixed(0)}</span>
                  {leg.exchange && (
                    <span className={classNames('text-[8px] text-white rounded px-0.5 font-bold flex-shrink-0', EX_BADGE[leg.exchange] ?? 'bg-zinc-500')}>
                      {EX_LABEL[leg.exchange] ?? leg.exchange}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Box spread summary line */}
            {opp.boxSummary && (
              <div className="mt-1.5 text-[10px] text-ink-3">{opp.boxSummary}</div>
            )}
          </div>
        ))}
      </div>}
    </div>
  )
}
