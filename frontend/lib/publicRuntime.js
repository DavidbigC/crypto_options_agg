function parseBooleanFlag(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
}

export function getPublicRuntime() {
  const appMode = process.env.NEXT_PUBLIC_APP_MODE === 'public' ? 'public' : 'private'
  const portfolioEnabled = parseBooleanFlag(process.env.NEXT_PUBLIC_ENABLE_PORTFOLIO, appMode !== 'public')
  const optimizerEnabled = parseBooleanFlag(process.env.NEXT_PUBLIC_ENABLE_OPTIMIZER, appMode !== 'public')

  return {
    appMode,
    portfolioEnabled,
    optimizerEnabled,
  }
}

export function isPortfolioEnabled() {
  return getPublicRuntime().portfolioEnabled
}

export function isOptimizerEnabled() {
  return getPublicRuntime().optimizerEnabled
}

export function getHeaderLinks() {
  const runtime = getPublicRuntime()
  return [
    { href: '/', label: 'Desk' },
    { href: '/analysis', label: 'Analysis' },
    { href: '/polysis', label: 'Polysis' },
    { href: '/builder', label: 'Builder' },
    ...(runtime.portfolioEnabled ? [{ href: '/portfolio', label: 'Portfolio' }] : []),
  ]
}
