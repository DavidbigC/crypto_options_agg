'use client'

import { useEffect, useMemo, useState } from 'react'
import Header from '@/components/Header'
import MiniChain from '@/components/builder/MiniChain'
import FuturesBar from '@/components/builder/FuturesBar'
import LegsPanel from '@/components/builder/LegsPanel'
import PnLChart from '@/components/builder/PnLChart'
import { Leg, OptionsData } from '@/types/options'
import {
  buildLiveSimulatorLegs,
  formatNumber,
  formatPercent,
  formatTimestamp,
  formatUsd,
  groupPositionsByCoin,
  portfolioCoins,
  PortfolioResponse,
  sortPositionsByNotional,
} from '@/lib/portfolio'

const API_URL = 'http://localhost:3500/api/portfolio/okx'
const OKX_FAMILY_MAP: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
}

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCoin, setSelectedCoin] = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null)
  const [spotPrice, setSpotPrice] = useState(0)
  const [simulatorLegs, setSimulatorLegs] = useState<Leg[]>([])
  const [hasSeededSimulator, setHasSeededSimulator] = useState(false)

  async function loadPortfolio(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)

    try {
      const response = await fetch(API_URL)
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load portfolio')
      }
      setPortfolio(payload)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load portfolio')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadPortfolio()
  }, [])

  useEffect(() => {
    if (!portfolio || hasSeededSimulator) return
    const liveLegs = buildLiveSimulatorLegs(portfolio.positions)
    setSimulatorLegs(liveLegs)
    const firstCoin = liveLegs[0]?.coin
    if (firstCoin === 'BTC' || firstCoin === 'ETH' || firstCoin === 'SOL') {
      setSelectedCoin(firstCoin)
    }
    setHasSeededSimulator(true)
  }, [portfolio, hasSeededSimulator])

  useEffect(() => {
    const family = OKX_FAMILY_MAP[selectedCoin]
    fetch(`http://localhost:3500/api/okx/options/${family}`)
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
    for (const expiryData of Object.values(optionsData.data)) {
      for (const contract of [...expiryData.calls, ...expiryData.puts]) {
        if (contract.symbol) optionMap.set(contract.symbol, contract.markVol || contract.impliedVolatility || 0.5)
      }
    }
    setSimulatorLegs((prev) => prev.map((leg) => {
      if (leg.coin !== selectedCoin || leg.type === 'future') return leg
      const markVol = optionMap.get(leg.symbol)
      return markVol ? { ...leg, markVol } : leg
    }))
  }, [optionsData, selectedCoin])

  const positionsByCoin = useMemo(
    () => groupPositionsByCoin(portfolio?.positions ?? []),
    [portfolio],
  )
  const availableCoins = useMemo(
    () => portfolioCoins(portfolio?.positions ?? []) as ('BTC' | 'ETH' | 'SOL')[],
    [portfolio],
  )
  const visibleLegs = useMemo(
    () => simulatorLegs.filter((leg) => leg.coin === selectedCoin),
    [simulatorLegs, selectedCoin],
  )

  function addLeg(leg: Omit<Leg, 'id'>) {
    setSimulatorLegs((prev) => [...prev, { ...leg, id: crypto.randomUUID() }])
  }

  function updateLeg(id: string, patch: Partial<Leg>) {
    setSimulatorLegs((prev) => prev.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)))
  }

  function removeLeg(id: string) {
    setSimulatorLegs((prev) => prev.filter((leg) => leg.id !== id))
  }

  function clearCoinLegs() {
    setSimulatorLegs((prev) => prev.filter((leg) => leg.coin !== selectedCoin))
  }

  function addFutureLeg(side: 'buy' | 'sell', entryPrice: number, expiry: string) {
    addLeg({
      exchange: 'okx',
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

  function resetToLivePositions() {
    if (!portfolio) return
    setSimulatorLegs(buildLiveSimulatorLegs(portfolio.positions))
  }

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange="okx" onExchangeChange={() => {}} />

      <main className="container mx-auto px-4 py-4 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-ink">Portfolio</h1>
            <p className="text-sm text-ink-2">
              OKX balances, live derivatives Greeks, and a what-if simulator seeded from your current book.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={resetToLivePositions}
              disabled={!portfolio}
              className="rounded-md border border-rim bg-card px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset to Live Positions
            </button>
            <button
              onClick={() => loadPortfolio(true)}
              disabled={loading || refreshing}
              className="rounded-md border border-rim bg-card px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="card">
            <p className="text-sm text-ink-2">Loading portfolio…</p>
          </div>
        ) : error ? (
          <div className="card">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        ) : portfolio ? (
          <>
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <SummaryCard label="Exchange" value={portfolio.exchange.toUpperCase()} />
              <SummaryCard label="Account" value={portfolio.account.label || 'OKX'} />
              <SummaryCard label="Permission" value={portfolio.account.permission || 'unknown'} />
              <SummaryCard label="Total Equity" value={formatUsd(portfolio.summary.totalEquityUsd)} />
              <SummaryCard label="Available Equity" value={formatUsd(portfolio.summary.availableEquityUsd)} />
              <SummaryCard label="Derivatives" value={String(portfolio.summary.derivativesCount)} />
              <SummaryCard label="Open Positions" value={String(portfolio.summary.openPositions)} />
              <SummaryCard label="Balances" value={String(portfolio.summary.balancesCount)} />
              <SummaryCard label="Settle Currency" value={portfolio.account.settleCurrency || 'N/A'} />
              <SummaryCard label="Updated" value={formatTimestamp(portfolio.summary.updatedAt)} />
            </section>

            <section className="card">
              <div className="mb-3">
                <h2 className="text-lg font-semibold text-ink">Derivatives Greeks</h2>
                <p className="text-sm text-ink-2">Live Greeks for your OKX options and futures book. Spot balances are excluded.</p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <GreekCard label="Net Delta" value={formatNumber(portfolio.greeks.total.delta, 3)} />
                <GreekCard label="Net Gamma" value={formatNumber(portfolio.greeks.total.gamma, 5)} />
                <GreekCard label="Net Theta" value={formatNumber(portfolio.greeks.total.theta, 3)} />
                <GreekCard label="Net Vega" value={formatNumber(portfolio.greeks.total.vega, 3)} />
              </div>

              <div className="mt-4 overflow-x-auto">
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
              </div>
            </section>

            <section className="card overflow-hidden">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Balances</h2>
                  <p className="text-sm text-ink-2">Informational balances only. They are not included in the simulator.</p>
                </div>
              </div>
              <div className="overflow-x-auto">
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
                    {portfolio.balances.map((balance) => (
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
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Simulator</h2>
                  <p className="text-sm text-ink-2">Seeded from live derivatives positions for the selected coin. Refresh does not overwrite your edits.</p>
                </div>
                <div className="flex gap-1">
                  {availableCoins.map((coin) => (
                    <button
                      key={coin}
                      onClick={() => setSelectedCoin(coin)}
                      className={`px-3 py-1 rounded text-xs font-medium ${selectedCoin === coin ? 'bg-tone text-white' : 'text-ink-2 border border-rim hover:border-ink-3'}`}
                    >
                      {coin}
                    </button>
                  ))}
                </div>
              </div>

              <MiniChain
                exchange="okx"
                coin={selectedCoin}
                onCoinChange={setSelectedCoin}
                optionsData={optionsData}
                spotPrice={spotPrice}
                onAddLeg={addLeg}
              />

              <FuturesBar
                coin={selectedCoin}
                onAdd={addFutureLeg}
                allowedExchanges={['okx']}
                defaultExchange="okx"
              />

              <PnLChart legs={visibleLegs} spotPrice={spotPrice || averageReferencePrice(positionsByCoin[selectedCoin] ?? [])} />

              <LegsPanel
                legs={visibleLegs}
                spotPrice={spotPrice || averageReferencePrice(positionsByCoin[selectedCoin] ?? [])}
                optionsData={optionsData}
                onUpdate={updateLeg}
                onRemove={removeLeg}
                onClearAll={clearCoinLegs}
              />
            </section>

            <section className="card overflow-hidden">
              <div className="mb-3">
                <h2 className="text-lg font-semibold text-ink">Open Positions</h2>
                <p className="text-sm text-ink-2">Live normalized derivatives positions from OKX.</p>
              </div>
              {portfolio.positions.length === 0 ? (
                <p className="text-sm text-ink-2">No open positions.</p>
              ) : (
                <div className="overflow-x-auto">
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
                        <th className="table-header text-right">Delta</th>
                        <th className="table-header text-right">Gamma</th>
                        <th className="table-header text-right">Theta</th>
                        <th className="table-header text-right">Vega</th>
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
                </div>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-2 text-base font-semibold text-ink break-words">{value}</div>
    </div>
  )
}

function GreekCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-rim bg-muted/50 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-2 text-lg font-semibold text-ink">{value}</div>
    </div>
  )
}

function averageReferencePrice(positions: PortfolioResponse['positions']) {
  if (!positions.length) return 0
  const prices = positions.map((position) => position.referencePrice).filter((price) => price > 0)
  if (!prices.length) return 0
  return prices.reduce((sum, price) => sum + price, 0) / prices.length
}
