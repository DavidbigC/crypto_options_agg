function formatUsdRange(low, high) {
  const fmt = (value) => `$${Number(value).toLocaleString('en-US')}`
  if (high === null || high === undefined) return `${fmt(low)}+`
  return `${fmt(low)}-${fmt(high)}`
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function mapPolymarketResponse(payload) {
  return {
    asset: payload?.asset ?? null,
    horizon: payload?.horizon ?? null,
    expiryDate: payload?.expiryDate ?? null,
    distribution: payload?.distribution ?? { source: 'none', bins: [] },
    summary: payload?.summary ?? {},
    pathSummary: payload?.pathSummary ?? null,
    confidence: payload?.confidence ?? null,
    repricing: payload?.repricing ?? { change24h: null, change7d: null },
    sourceMarkets: Array.isArray(payload?.sourceMarkets) ? payload.sourceMarkets : [],
    pathMarkets: Array.isArray(payload?.pathMarkets) ? payload.pathMarkets : [],
  }
}

export function mapPolymarketSurface(payload) {
  const horizons = payload?.horizons && typeof payload.horizons === 'object' ? payload.horizons : {}
  return {
    asset: payload?.asset ?? null,
    generatedAt: payload?.generatedAt ?? null,
    horizons: {
      daily: horizons.daily ? mapPolymarketResponse(horizons.daily) : null,
      weekly: horizons.weekly ? mapPolymarketResponse(horizons.weekly) : null,
      monthly: horizons.monthly ? mapPolymarketResponse(horizons.monthly) : null,
      yearly: horizons.yearly ? mapPolymarketResponse(horizons.yearly) : null,
    },
  }
}

export function getPolysisActiveSpot(spotOverride, referenceSpot) {
  const override = toFiniteNumber(spotOverride)
  if (override && override > 0) return override
  if (referenceSpot && referenceSpot > 0) return referenceSpot
  return null
}

function formatExpiryLabel(value) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function buildPolysisExpirySeries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.expiryDate)
    .map((entry) => {
      const pathMove = toFiniteNumber(entry?.pathSummary?.pathMovePct)
      const expectedMove = toFiniteNumber(entry?.summary?.expectedMovePct)
      const movePct = pathMove !== null
        ? pathMove
        : expectedMove !== null
          ? expectedMove
          : null

      return {
        asset: entry.asset ?? null,
        horizon: entry.horizon ?? null,
        expiryDate: entry.expiryDate,
        expiryLabel: formatExpiryLabel(entry.expiryDate),
        movePct,
        upPct: toFiniteNumber(entry?.pathSummary?.upsidePathPct),
        downPct: toFiniteNumber(entry?.pathSummary?.downsidePathPct),
        signalType: pathMove !== null ? 'path' : 'terminal',
        marketCount: Number(entry?.confidence?.marketCount ?? entry?.sourceMarkets?.length ?? 0),
      }
    })
    .sort((left, right) => new Date(left.expiryDate).getTime() - new Date(right.expiryDate).getTime())
}

export function buildPolysisDistributionChartData(distribution) {
  return (distribution?.bins ?? []).map((bin) => ({
    label: formatUsdRange(bin.low, bin.high),
    low: bin.low,
    high: bin.high ?? null,
    probability: Number((Number(bin.probability || 0) * 100).toFixed(2)),
  }))
}

export function formatPolysisConfidence(confidence) {
  if (!confidence || typeof confidence.score !== 'number' || !confidence.label) {
    return 'Confidence unavailable'
  }

  const label = `${confidence.label}`.charAt(0).toUpperCase() + `${confidence.label}`.slice(1)
  return `${label} confidence (${confidence.score}/100)`
}
