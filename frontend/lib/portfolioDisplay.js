export function getPortfolioDisplayData(portfolio, fallbackExchangeLabel) {
  const exchangeId = typeof portfolio?.exchange === 'string' && portfolio.exchange
    ? portfolio.exchange
    : ''
  const account = portfolio?.account ?? {}
  const summary = portfolio?.summary ?? {}
  const totalGreeks = portfolio?.greeks?.total ?? {}
  const greeksByCoin = portfolio?.greeks?.byCoin ?? {}
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
