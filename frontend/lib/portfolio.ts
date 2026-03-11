import { Leg } from '@/types/options'
import { normalizeImportedPositionSize } from './positionSizing.js'

export type PortfolioExchange = 'okx' | 'bybit'

export interface PortfolioAccount {
  label: string
  permission: string
  positionMode: string
  greeksType: string
  settleCurrency: string
}

export interface PortfolioSummary {
  totalEquityUsd: number
  availableEquityUsd: number | null
  openPositions: number
  derivativesCount: number
  balancesCount: number
  updatedAt: string
}

export interface PortfolioBalance {
  currency: string
  equity: number
  usdValue: number
  available: number
  frozen: number
  upl: number
}

export interface PortfolioPosition {
  instrument: string
  instrumentType: string
  coin: string
  kind: 'option' | 'future' | 'swap' | 'other'
  optionType: 'call' | 'put' | null
  expiry: string | null
  strike: number | null
  referencePrice: number
  marginMode: string
  size: number
  averagePrice: number
  markPrice: number
  unrealizedPnl: number
  unrealizedPnlRatio: number
  delta: number
  gamma: number
  theta: number
  vega: number
  notionalUsd: number
}

export interface PortfolioGreeks {
  delta: number
  gamma: number
  theta: number
  vega: number
}

export interface PortfolioResponse {
  exchange: PortfolioExchange
  account: PortfolioAccount
  summary: PortfolioSummary
  balances: PortfolioBalance[]
  greeks: {
    total: PortfolioGreeks
    byCoin: Record<string, PortfolioGreeks>
  }
  positions: PortfolioPosition[]
}

export function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatUsd(value: number | null, digits = 2) {
  if (value === null) return 'N/A'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatPercent(value: number, digits = 2) {
  return `${formatNumber(value * 100, digits)}%`
}

export function formatTimestamp(value: string) {
  return new Date(value).toLocaleString()
}

export function sortPositionsByNotional(positions: PortfolioPosition[]) {
  return [...positions].sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd))
}

export function portfolioCoins(positions: PortfolioPosition[]) {
  const coins = new Set<string>()
  for (const position of positions) {
    if (position.coin) coins.add(position.coin)
  }
  for (const coin of ['BTC', 'ETH', 'SOL']) coins.add(coin)
  return Array.from(coins)
}

export function groupPositionsByCoin(positions: PortfolioPosition[]) {
  return positions.reduce<Record<string, PortfolioPosition[]>>((acc, position) => {
    const coin = position.coin || 'OTHER'
    if (!acc[coin]) acc[coin] = []
    acc[coin].push(position)
    return acc
  }, {})
}

export function buildLiveSimulatorLegs(
  positions: PortfolioPosition[],
  exchange: PortfolioExchange = 'okx',
): Leg[] {
  return positions
    .filter((position) => position.kind === 'option' || position.kind === 'future' || position.kind === 'swap')
    .map((position) => {
      const coin = position.coin as 'BTC' | 'ETH' | 'SOL'
      const type = position.kind === 'option'
        ? (position.optionType ?? 'call')
        : 'future'
      const { qty, contractSize } = normalizeImportedPositionSize({
        exchange,
        coin,
        kind: position.kind,
        size: position.size,
      })
      const entryPrice = position.kind === 'option'
        ? position.averagePrice * (position.referencePrice || 1)
        : position.averagePrice

      return {
        id: crypto.randomUUID(),
        exchange,
        coin,
        symbol: position.instrument,
        expiry: position.expiry || 'perpetual',
        strike: position.strike ?? 0,
        type,
        side: position.size >= 0 ? 'buy' : 'sell',
        qty,
        entryPrice,
        markVol: 0.5,
        contractSize,
        enabled: true,
      } satisfies Leg
    })
}
