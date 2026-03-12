function parseBooleanFlag(value, fallback) {
  if (value === undefined) return fallback
  return String(value).toLowerCase() === 'true'
}

function parseOrigins(value) {
  return String(value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function getRuntimeConfig(env = process.env) {
  const appMode = env.APP_MODE === 'public' ? 'public' : 'private'
  const corsOrigins = appMode === 'public'
    ? parseOrigins(env.CORS_ORIGINS)
    : ['http://localhost:3000', 'http://127.0.0.1:3000']

  return {
    appMode,
    loadDotenv: parseBooleanFlag(env.LOAD_DOTENV, appMode !== 'public'),
    enablePortfolio: parseBooleanFlag(env.ENABLE_PORTFOLIO, appMode !== 'public'),
    enableOptimizer: parseBooleanFlag(env.ENABLE_OPTIMIZER, appMode !== 'public'),
    corsOrigins,
  }
}

export function isCorsOriginAllowed(origin, runtimeConfig) {
  if (!origin) return true
  return (runtimeConfig?.corsOrigins ?? []).includes(origin)
}
