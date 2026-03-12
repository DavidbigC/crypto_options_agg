function parseBooleanFlag(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
}

export function getPublicRuntime(env = process.env) {
  const appMode = env.NEXT_PUBLIC_APP_MODE === 'public' ? 'public' : 'private'
  const portfolioEnabled = parseBooleanFlag(env.NEXT_PUBLIC_ENABLE_PORTFOLIO, appMode !== 'public')
  const optimizerEnabled = parseBooleanFlag(env.NEXT_PUBLIC_ENABLE_OPTIMIZER, appMode !== 'public')

  return {
    appMode,
    portfolioEnabled,
    optimizerEnabled,
  }
}

export function isPortfolioEnabled(env = process.env) {
  return getPublicRuntime(env).portfolioEnabled
}

export function isOptimizerEnabled(env = process.env) {
  return getPublicRuntime(env).optimizerEnabled
}

export function getHeaderLinks(env = process.env) {
  const runtime = getPublicRuntime(env)
  return [
    { href: '/analysis', label: 'Analysis' },
    { href: '/polysis', label: 'Polysis' },
    ...(runtime.optimizerEnabled ? [{ href: '/optimizer', label: 'Optimizer' }] : []),
    { href: '/builder', label: 'Strategy Builder' },
    ...(runtime.portfolioEnabled ? [{ href: '/portfolio', label: 'Portfolio' }] : []),
  ]
}
