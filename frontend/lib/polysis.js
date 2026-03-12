function formatUsdRange(low, high) {
  const fmt = (value) => `$${Number(value).toLocaleString('en-US')}`
  if (high === null || high === undefined) return `${fmt(low)}+`
  return `${fmt(low)}-${fmt(high)}`
}

export function mapPolymarketResponse(payload) {
  return {
    asset: payload?.asset ?? null,
    horizon: payload?.horizon ?? null,
    distribution: payload?.distribution ?? { source: 'none', bins: [] },
    summary: payload?.summary ?? {},
    pathSummary: payload?.pathSummary ?? null,
    confidence: payload?.confidence ?? null,
    repricing: payload?.repricing ?? { change24h: null, change7d: null },
    sourceMarkets: Array.isArray(payload?.sourceMarkets) ? payload.sourceMarkets : [],
    pathMarkets: Array.isArray(payload?.pathMarkets) ? payload.pathMarkets : [],
  }
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
