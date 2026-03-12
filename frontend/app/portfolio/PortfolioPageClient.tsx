'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Header from '@/components/Header'
import MiniChain from '@/components/builder/MiniChain'
import FuturesBar from '@/components/builder/FuturesBar'
import LegsPanel from '@/components/builder/LegsPanel'
import PnLChart from '@/components/builder/PnLChart'
import { Exchange, Leg, OptionsData } from '@/types/options'
import {
  buildLiveSimulatorLegs,
  formatNumber,
  formatPercent,
  formatTimestamp,
  formatUsd,
  portfolioCoins,
  PortfolioBalance,
  PortfolioExchange,
  PortfolioResponse,
  sortPositionsByNotional,
} from '@/lib/portfolio'
import { filterVisibleBalances } from '@/lib/portfolioBalances.js'
import { clearImportedExchangeLegs, mergeImportedExchangeLegs } from '@/lib/mixedSimulator.js'
import { apiPath } from '@/lib/apiBase.js'

const PORTFOLIO_API_URL: Record<PortfolioExchange, string> = {
  okx: apiPath('portfolio/okx'),
  bybit: apiPath('portfolio/bybit'),
}

const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

const EXCHANGE_LABEL: Record<PortfolioExchange, string> = {
  okx: 'OKX',
  bybit: 'Bybit',
}

const EXCHANGE_ACCENT: Record<PortfolioExchange, string> = {
  okx: 'border-l-amber-500',
  bybit: 'border-l-violet-500',
}

type ExchangeState<T> = Record<PortfolioExchange, T>
type SimulatorLeg = Leg & { source?: 'manual' | 'portfolio-import' }

function buildOptionsUrl(exchange: Exchange, coin: 'BTC' | 'ETH' | 'SOL') {
  return exchange === 'okx'
    ? apiPath(`okx/options/${OKX_FAMILY_MAP[coin]}`)
    : exchange === 'combined'
      ? apiPath(`combined/options/${coin}`)
      : apiPath(`bybit/snapshot/${coin}`)
}

export default function PortfolioPageClient() {
  const [portfolios, setPortfolios] = useState<ExchangeState<PortfolioResponse | null>>({
    okx: null,
    bybit: null,
  })
  const [loading, setLoading] = useState<ExchangeState<boolean>>({
    okx: true,
    bybit: true,
  })
  const [errors, setErrors] = useState<ExchangeState<string | null>>({
    okx: null,
    bybit: null,
  })
  const [refreshing, setRefreshing] = useState(false)
  const [showExchange, setShowExchange] = useState<ExchangeState<boolean>>({
    okx: true,
    bybit: true,
  })
  const [selectedCoin, setSelectedCoin] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState(0)
  const [simulatorLegs, setSimulatorLegs] = useState<SimulatorLeg[]>([])
  const [hasSeededSimulator, setHasSeededSimulator] = useState(false)

  async function loadExchangePortfolio(exchange: PortfolioExchange) {
    setLoading((prev) => ({ ...prev, [exchange]: true }))

    try {
      const response = await fetch(PORTFOLIO_API_URL[exchange])
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to load ${EXCHANGE_LABEL[exchange]} portfolio`)
      }

      setPortfolios((prev) => ({ ...prev, [exchange]: payload }))
      setErrors((prev) => ({ ...prev, [exchange]: null }))
    } catch (err) {
      setPortfolios((prev) => ({ ...prev, [exchange]: null }))
      setErrors((prev) => ({
        ...prev,
        [exchange]: err instanceof Error ? err.message : `Failed to load ${EXCHANGE_LABEL[exchange]} portfolio`,
      }))
    } finally {
      setLoading((prev) => ({ ...prev, [exchange]: false }))
    }
  }

  async function loadPortfolios(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    await Promise.all([
      loadExchangePortfolio('okx'),
      loadExchangePortfolio('bybit'),
    ])
    if (isRefresh) setRefreshing(false)
  }

  useEffect(() => {
    loadPortfolios()
  }, [])

  useEffect(() => {
    if (hasSeededSimulator) return
    const seedSource = portfolios.okx ? 'okx' : portfolios.bybit ? 'bybit' : null
    if (!seedSource) return

    const liveLegs = buildLiveSimulatorLegs(portfolios[seedSource]?.positions ?? [], seedSource)
      .map((leg) => ({ ...leg, source: 'portfolio-import' as const }))
    setSimulatorLegs((prev) => mergeImportedExchangeLegs(prev, liveLegs, seedSource))
    const firstCoin = liveLegs[0]?.coin
    if (firstCoin === 'BTC' || firstCoin === 'ETH' || firstCoin === 'SOL') {
      setSelectedCoin(firstCoin)
    }
    setHasSeededSimulator(true)
  }, [hasSeededSimulator, portfolios])

  useEffect(() => {
    fetch(buildOptionsUrl('combined', selectedCoin))
      .then((response) => response.json())
      .then((payload) => {
        if (!payload || payload.error || !payload.data) return
        setOptionsData(payload)
        setSpotPrice(payload.spotPrice ?? 0)
      })
      .catch(() => {})
  }, [selectedCoin])

  useEffect(() => {
    if (!optionsData) return
    const optionMap = new Map<string, number>()
    for (const [expiry, expiryData] of Object.entries(optionsData.data)) {
      for (const contract of expiryData.calls) {
        optionMap.set(`${expiry}|call|${contract.strike}`, contract.markVol || contract.impliedVolatility || 0.5)
      }
      for (const contract of expiryData.puts) {
        optionMap.set(`${expiry}|put|${contract.strike}`, contract.markVol || contract.impliedVolatility || 0.5)
      }
    }
    setSimulatorLegs((prev) => prev.map((leg) => {
      if (leg.coin !== selectedCoin || leg.type === 'future') return leg
      const markVol = optionMap.get(`${leg.expiry}|${leg.type}|${leg.strike}`)
      return markVol ? { ...leg, markVol } : leg
    }))
  }, [optionsData, selectedCoin])

  const simulatorLoadedExchanges = useMemo(() => {
    const loaded = new Set<PortfolioExchange>()
    for (const leg of simulatorLegs) {
      if (leg.source === 'portfolio-import' && (leg.exchange === 'okx' || leg.exchange === 'bybit')) {
        loaded.add(leg.exchange)
      }
    }
    return loaded
  }, [simulatorLegs])

  const availableCoins = useMemo(
    () => Array.from(new Set(
      simulatorLegs
        .map((leg) => leg.coin)
        .filter((coin): coin is 'BTC' | 'ETH' | 'SOL' => coin === 'BTC' || coin === 'ETH' || coin === 'SOL'),
    )),
    [simulatorLegs],
  )

  useEffect(() => {
    if (!availableCoins.includes(selectedCoin)) {
      setSelectedCoin(availableCoins[0] ?? 'BTC')
    }
  }, [availableCoins, selectedCoin])

  const visibleLegs = useMemo(
    () => simulatorLegs.filter((leg) => leg.coin === selectedCoin),
    [selectedCoin, simulatorLegs],
  )

  const visibleExchanges = useMemo(
    () => Array.from(new Set(
      visibleLegs
        .map((leg) => leg.exchange)
        .filter((exchange): exchange is PortfolioExchange => exchange === 'okx' || exchange === 'bybit'),
    )),
    [visibleLegs],
  )

  const hasVisibleExchange = showExchange.okx || showExchange.bybit

  function addLeg(leg: Omit<Leg, 'id'>) {
    setSimulatorLegs((prev) => [...prev, { ...leg, id: crypto.randomUUID(), source: 'manual' }])
  }

  function updateLeg(id: string, patch: Partial<SimulatorLeg>) {
    setSimulatorLegs((prev) => prev.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)))
  }

  function removeLeg(id: string) {
    setSimulatorLegs((prev) => prev.filter((leg) => leg.id !== id))
  }

  function clearCoinLegs() {
    setSimulatorLegs((prev) => prev.filter((leg) => leg.coin !== selectedCoin))
  }

  function addFutureLeg(side: 'buy' | 'sell', entryPrice: number, expiry: string, exchange: string) {
    addLeg({
      exchange: exchange as Exchange,
      coin: selectedCoin,
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

  function loadExchangeIntoSimulator(exchange: PortfolioExchange) {
    const portfolio = portfolios[exchange]
    if (!portfolio) return
    const importedLegs: SimulatorLeg[] = buildLiveSimulatorLegs(portfolio.positions, exchange)
      .map((leg) => ({ ...leg, source: 'portfolio-import' }))
    setSimulatorLegs((prev) => mergeImportedExchangeLegs(prev, importedLegs, exchange))
    const nextCoin = portfolioCoins(portfolio.positions)[0]
    if (nextCoin === 'BTC' || nextCoin === 'ETH' || nextCoin === 'SOL') {
      setSelectedCoin(nextCoin)
    }
  }

  function clearImportedExchange(exchange: PortfolioExchange) {
    setSimulatorLegs((prev) => clearImportedExchangeLegs(prev, exchange))
  }

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange="okx" onExchangeChange={() => {}} />

      <main className="container mx-auto px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-xl font-semibold text-ink">Portfolio</h1>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setShowExchange((prev) => ({ ...prev, okx: !prev.okx }))}
              className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${showExchange.okx ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-rim bg-card text-ink-3 hover:border-ink-3'}`}
            >
              OKX
            </button>
            <button
              onClick={() => setShowExchange((prev) => ({ ...prev, bybit: !prev.bybit }))}
              className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${showExchange.bybit ? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-400' : 'border-rim bg-card text-ink-3 hover:border-ink-3'}`}
            >
              Bybit
            </button>
            <span className="h-4 w-px bg-rim mx-0.5" />
            <button
              onClick={() => clearImportedExchange('okx')}
              disabled={!simulatorLoadedExchanges.has('okx')}
              className="rounded border border-rim bg-card px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear OKX
            </button>
            <button
              onClick={() => clearImportedExchange('bybit')}
              disabled={!simulatorLoadedExchanges.has('bybit')}
              className="rounded border border-rim bg-card px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear Bybit
            </button>
            <button
              onClick={() => loadPortfolios(true)}
              disabled={refreshing}
              className="rounded border border-rim bg-card px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {!hasVisibleExchange ? (
          <div className="card">
            <p className="text-xs text-ink-2">Both exchanges hidden. Use the buttons above to show a card again.</p>
          </div>
        ) : null}

        {showExchange.okx ? (
          <PortfolioExchangeCard
            exchange="okx"
            portfolio={portfolios.okx}
            loading={loading.okx}
            error={errors.okx}
            isLoadedInSimulator={simulatorLoadedExchanges.has('okx')}
            onUseForSimulator={() => loadExchangeIntoSimulator('okx')}
          />
        ) : null}

        {showExchange.bybit ? (
          <PortfolioExchangeCard
            exchange="bybit"
            portfolio={portfolios.bybit}
            loading={loading.bybit}
            error={errors.bybit}
            isLoadedInSimulator={simulatorLoadedExchanges.has('bybit')}
            onUseForSimulator={() => loadExchangeIntoSimulator('bybit')}
          />
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-ink">
              Simulator{' '}
              <span className="text-xs font-normal text-ink-3">
                — mixed book · loads append by exchange · refresh won't overwrite edits
              </span>
            </h2>
            <div className="flex gap-1 flex-wrap">
              {availableCoins.map((coin) => (
                <button
                  key={coin}
                  onClick={() => setSelectedCoin(coin)}
                  className={`px-2.5 py-0.5 rounded text-xs font-medium ${selectedCoin === coin ? 'bg-tone text-white' : 'text-ink-2 border border-rim hover:border-ink-3'}`}
                >
                  {coin}
                </button>
              ))}
            </div>
          </div>

          <MiniChain
            exchange="combined"
            coin={selectedCoin}
            onCoinChange={setSelectedCoin}
            optionsData={optionsData}
            spotPrice={spotPrice}
            onAddLeg={addLeg}
          />

          <FuturesBar
            coin={selectedCoin}
            onAdd={addFutureLeg}
            allowedExchanges={visibleExchanges.length > 0 ? visibleExchanges : ['okx', 'bybit']}
            defaultExchange={visibleExchanges[0] ?? 'okx'}
          />

          <PnLChart legs={visibleLegs} spotPrice={spotPrice} />

          <LegsPanel
            legs={visibleLegs}
            spotPrice={spotPrice}
            optionsData={optionsData}
            onUpdate={updateLeg}
            onRemove={removeLeg}
            onClearAll={clearCoinLegs}
          />
        </section>
      </main>
    </div>
  )
}

function PortfolioExchangeCard({
  exchange,
  portfolio,
  loading,
  error,
  isLoadedInSimulator,
  onUseForSimulator,
}: {
  exchange: PortfolioExchange
  portfolio: PortfolioResponse | null
  loading: boolean
  error: string | null
  isLoadedInSimulator: boolean
  onUseForSimulator: () => void
}) {
  const visibleBalances: PortfolioBalance[] = portfolio ? filterVisibleBalances(portfolio.balances) : []

  return (
    <section className={`bg-card border border-rim border-l-4 ${EXCHANGE_ACCENT[exchange]} rounded-lg p-4 space-y-3 shadow-sm`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-ink">{EXCHANGE_LABEL[exchange]}</span>
          {isLoadedInSimulator && (
            <span className="text-xs bg-tone/15 text-tone rounded px-1.5 py-0.5 font-medium">Simulator</span>
          )}
        </div>
        <button
          onClick={onUseForSimulator}
          disabled={!portfolio}
          className="rounded border border-rim bg-card px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoadedInSimulator ? 'Reload into Simulator' : 'Load into Simulator'}
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-ink-2">Loading {EXCHANGE_LABEL[exchange]} portfolio…</p>
      ) : error ? (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : portfolio ? (
        <>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 border-t border-rim pt-2.5">
            {([
              ['Exchange', portfolio.exchange.toUpperCase()],
              ['Account', portfolio.account.label || EXCHANGE_LABEL[exchange]],
              ['Permission', portfolio.account.permission || 'unknown'],
              ['Total Equity', formatUsd(portfolio.summary.totalEquityUsd)],
              ['Available', formatUsd(portfolio.summary.availableEquityUsd)],
              ['Derivatives', String(portfolio.summary.derivativesCount)],
              ['Open Positions', String(portfolio.summary.openPositions)],
              ['Balances', String(visibleBalances.length)],
              ['Settle', portfolio.account.settleCurrency || 'N/A'],
              ['Updated', formatTimestamp(portfolio.summary.updatedAt)],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-1">
                <dt className="text-xs text-ink-3">{label}:</dt>
                <dd className="text-xs font-semibold text-ink">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="space-y-1.5 border-t border-rim pt-2.5">
            <div className="flex items-center gap-6 flex-wrap">
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Greeks</span>
              <div className="flex gap-5 flex-wrap">
                {([
                  ['Δ', formatNumber(portfolio.greeks.total.delta, 3)],
                  ['Γ', formatNumber(portfolio.greeks.total.gamma, 5)],
                  ['Θ', formatNumber(portfolio.greeks.total.theta, 3)],
                  ['Ψ', formatNumber(portfolio.greeks.total.vega, 3)],
                ] as [string, string][]).map(([sym, val]) => (
                  <span key={sym} className="flex items-baseline gap-0.5">
                    <span className="text-xs text-ink-3 font-medium">{sym}</span>
                    <span className="text-sm font-semibold text-ink">{val}</span>
                  </span>
                ))}
              </div>
            </div>

            <CompactTable>
              <table className="min-w-full border-collapse">
                <thead>
                  <tr>
                    <th className="table-header text-left">Coin</th>
                    <th className="table-header text-right">Delta</th>
                    <th className="table-header text-right">Gamma</th>
                    <th className="table-header text-right">Theta</th>
                    <th className="table-header text-right">Vega</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(portfolio.greeks.byCoin).map(([coin, greeks]) => (
                    <tr key={coin} className="border-b border-rim last:border-b-0">
                      <td className="table-cell font-medium text-ink">{coin}</td>
                      <td className="table-cell text-right">{formatNumber(greeks.delta, 3)}</td>
                      <td className="table-cell text-right">{formatNumber(greeks.gamma, 5)}</td>
                      <td className="table-cell text-right">{formatNumber(greeks.theta, 3)}</td>
                      <td className="table-cell text-right">{formatNumber(greeks.vega, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CompactTable>
          </div>

          <div className="space-y-1.5 border-t border-rim pt-2.5">
            <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              Balances <span className="normal-case font-normal text-ink-3">— not included in simulator</span>
            </h3>
            <CompactTable>
              <table className="min-w-full border-collapse">
                <thead>
                  <tr>
                    <th className="table-header text-left">Currency</th>
                    <th className="table-header text-right">Equity</th>
                    <th className="table-header text-right">USD Value</th>
                    <th className="table-header text-right">Available</th>
                    <th className="table-header text-right">Frozen</th>
                    <th className="table-header text-right">UPL</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBalances.map((balance) => (
                    <tr key={balance.currency} className="border-b border-rim last:border-b-0">
                      <td className="table-cell font-medium text-ink">{balance.currency}</td>
                      <td className="table-cell text-right">{formatNumber(balance.equity, 6)}</td>
                      <td className="table-cell text-right">{formatUsd(balance.usdValue)}</td>
                      <td className="table-cell text-right">{formatNumber(balance.available, 6)}</td>
                      <td className="table-cell text-right">{formatNumber(balance.frozen, 6)}</td>
                      <td className={`table-cell text-right ${balance.upl > 0 ? 'price-positive' : balance.upl < 0 ? 'price-negative' : 'price-neutral'}`}>
                        {formatNumber(balance.upl, 6)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CompactTable>
            {visibleBalances.length === 0 ? (
              <p className="text-xs text-ink-2">No BTC, ETH, or USDT balances above $1.</p>
            ) : null}
          </div>

          <div className="space-y-1.5 border-t border-rim pt-2.5">
            <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
              Open Positions <span className="normal-case font-normal text-ink-3">— live normalized derivatives from {EXCHANGE_LABEL[exchange]}</span>
            </h3>
            {portfolio.positions.length === 0 ? (
              <p className="text-xs text-ink-2">No open positions.</p>
            ) : (
              <CompactTable>
                <table className="min-w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="table-header text-left">Instrument</th>
                      <th className="table-header text-left">Coin</th>
                      <th className="table-header text-left">Kind</th>
                      <th className="table-header text-left">Margin</th>
                      <th className="table-header text-right">Size</th>
                      <th className="table-header text-right">Avg Px</th>
                      <th className="table-header text-right">Mark Px</th>
                      <th className="table-header text-right">UPL</th>
                      <th className="table-header text-right">UPL %</th>
                      <th className="table-header text-right">Δ</th>
                      <th className="table-header text-right">Γ</th>
                      <th className="table-header text-right">Θ</th>
                      <th className="table-header text-right">Ψ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortPositionsByNotional(portfolio.positions).map((position) => (
                      <tr key={`${position.instrument}-${position.marginMode}-${position.size}`} className="border-b border-rim last:border-b-0">
                        <td className="table-cell font-medium text-ink">{position.instrument}</td>
                        <td className="table-cell">{position.coin}</td>
                        <td className="table-cell">{position.kind}</td>
                        <td className="table-cell">{position.marginMode || 'N/A'}</td>
                        <td className={`table-cell text-right ${position.size > 0 ? 'price-positive' : 'price-negative'}`}>
                          {formatNumber(position.size, 4)}
                        </td>
                        <td className="table-cell text-right">{formatNumber(position.averagePrice, 6)}</td>
                        <td className="table-cell text-right">{formatNumber(position.markPrice, 6)}</td>
                        <td className={`table-cell text-right ${position.unrealizedPnl > 0 ? 'price-positive' : position.unrealizedPnl < 0 ? 'price-negative' : 'price-neutral'}`}>
                          {formatNumber(position.unrealizedPnl, 6)}
                        </td>
                        <td className={`table-cell text-right ${position.unrealizedPnlRatio > 0 ? 'price-positive' : position.unrealizedPnlRatio < 0 ? 'price-negative' : 'price-neutral'}`}>
                          {formatPercent(position.unrealizedPnlRatio, 2)}
                        </td>
                        <td className="table-cell text-right">{formatNumber(position.delta, 4)}</td>
                        <td className="table-cell text-right">{formatNumber(position.gamma, 6)}</td>
                        <td className="table-cell text-right">{formatNumber(position.theta, 4)}</td>
                        <td className="table-cell text-right">{formatNumber(position.vega, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CompactTable>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-ink-2">No portfolio data available.</p>
      )}
    </section>
  )
}

function CompactTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto [&_.table-cell]:!py-1 [&_.table-cell]:!px-2 [&_.table-cell]:!text-xs [&_.table-header]:!py-1 [&_.table-header]:!px-2 [&_.table-header]:!text-xs">
      {children}
    </div>
  )
}
