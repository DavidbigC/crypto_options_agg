/**
 * @typedef {import('./portfolio').PortfolioGreeks} PortfolioGreeks
 * @typedef {import('./portfolio').PortfolioPosition} PortfolioPosition
 * @typedef {import('./portfolio').PortfolioResponse} PortfolioResponse
 */

/**
 * @param {PortfolioResponse | null | undefined} portfolio
 * @param {string} fallbackExchangeLabel
 */
export function getPortfolioDisplayData(portfolio, fallbackExchangeLabel) {
  const exchangeId = typeof portfolio?.exchange === 'string' && portfolio.exchange
    ? portfolio.exchange
    : ''
  const account = portfolio?.account ?? {}
  const summary = portfolio?.summary ?? {}
  /** @type {PortfolioGreeks} */
  const totalGreeks = portfolio?.greeks?.total ?? { delta: 0, gamma: 0, theta: 0, vega: 0 }
  /** @type {Record<string, PortfolioGreeks>} */
  const greeksByCoin = portfolio?.greeks?.byCoin ?? {}
  /** @type {PortfolioPosition[]} */
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : []

  return {
    exchangeName: exchangeId ? exchangeId.toUpperCase() : fallbackExchangeLabel,
    accountLabel: account.label || fallbackExchangeLabel,
    permission: account.permission || 'unknown',
    settleCurrency: account.settleCurrency || 'N/A',
    totalEquityUsd: summary.totalEquityUsd ?? 0,
    availableEquityUsd: summary.availableEquityUsd ?? null,
    derivativesCount: summary.derivativesCount ?? 0,
    openPositions: summary.openPositions ?? positions.length,
    updatedAt: summary.updatedAt || new Date(0).toISOString(),
    totalGreeks: {
      delta: totalGreeks.delta ?? 0,
      gamma: totalGreeks.gamma ?? 0,
      theta: totalGreeks.theta ?? 0,
      vega: totalGreeks.vega ?? 0,
    },
    greeksByCoin,
    positions,
  }
}
