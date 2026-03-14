const ASSET_PATTERNS = [
  { symbol: 'BTC', pattern: /\b(?:btc|bitcoin)\b/i },
  { symbol: 'ETH', pattern: /\b(?:eth|ethereum)\b/i },
  { symbol: 'SOL', pattern: /\b(?:sol|solana)\b/i },
]

const HORIZON_PATTERNS = [
  { horizon: 'daily', pattern: /\b(?:today|daily|tomorrow)\b/i },
  { horizon: 'weekly', pattern: /\b(?:this week|weekly|week)\b/i },
  { horizon: 'monthly', pattern: /\b(?:this month|monthly|month)\b/i },
  { horizon: 'yearly', pattern: /\b(?:this year|yearly|year)\b/i },
]

function parseDollarNumber(rawValue) {
  if (!rawValue) return null
  const normalized = rawValue.replace(/[$,\s]/g, '')
  const multiplier = normalized.toLowerCase().endsWith('k') ? 1_000 : 1
  const numeric = Number.parseFloat(normalized.replace(/k$/i, ''))
  if (!Number.isFinite(numeric)) return null
  return numeric * multiplier
}

export function extractPolymarketAsset(text = '') {
  for (const { symbol, pattern } of ASSET_PATTERNS) {
    if (pattern.test(text)) return symbol
  }
  return null
}

export function extractPolymarketHorizon(text = '') {
  for (const { horizon, pattern } of HORIZON_PATTERNS) {
    if (pattern.test(text)) return horizon
  }
  return null
}

export function classifyPolymarketMarket(market = {}) {
  const question = String(market.question ?? market.title ?? '').trim()
  if (!question) {
    return { type: 'unknown', confidence: 'low', reason: 'Missing market question' }
  }

  const rangeMatch = question.match(/\$?\s*([\d,.]+k?)\s*-\s*\$?\s*([\d,.]+k?)/i)
  if (rangeMatch && /\b(?:where will|close)\b/i.test(question)) {
    const low = parseDollarNumber(rangeMatch[1])
    const high = parseDollarNumber(rangeMatch[2])
    if (low !== null && high !== null && high > low) {
      return {
        type: 'range',
        range: { low, high },
        confidence: 'high',
      }
    }
  }

  const dipMatch = question.match(/\b(?:dip(?:\s+to)?|drop(?:\s+to)?|fall(?:\s+to)?)\s+\$?\s*([\d,.]+k?)/i)
  if (dipMatch) {
    const barrier = parseDollarNumber(dipMatch[1])
    if (barrier !== null) {
      return {
        type: 'path',
        direction: 'below',
        barrier,
        confidence: 'high',
      }
    }
  }

  const pathMatch = question.match(/\b(?:hit|touch|reach)\s+\$?\s*([\d,.]+k?)/i)
  if (pathMatch) {
    const barrier = parseDollarNumber(pathMatch[1])
    if (barrier !== null) {
      return {
        type: 'path',
        direction: 'above',
        barrier,
        confidence: 'high',
      }
    }
  }

  const thresholdMatch = question.match(/\b(?:above|over|below|under)\s+\$?\s*([\d,.]+k?)/i)
  if (thresholdMatch) {
    const strike = parseDollarNumber(thresholdMatch[1])
    if (strike !== null) {
      return {
        type: 'threshold',
        direction: /\b(?:above|over)\b/i.test(question) ? 'above' : 'below',
        strike,
        confidence: 'high',
      }
    }
  }

  return {
    type: 'unknown',
    confidence: 'low',
    reason: 'Ambiguous market title',
  }
}

function clampProbability(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function roundProbability(value) {
  return Number(clampProbability(value).toFixed(6))
}

function toDistributionEntry(market) {
  const classification = classifyPolymarketMarket(market)
  const probability = clampProbability(Number(market.lastTradePrice))
  return {
    ...classification,
    probability,
  }
}

export function buildDistributionFromMarkets(markets = []) {
  const classified = markets.map(toDistributionEntry)
  const rangeMarkets = classified
    .filter((market) => market.type === 'range')
    .sort((a, b) => a.range.low - b.range.low)

  if (rangeMarkets.length) {
    return {
      source: 'range',
      bins: rangeMarkets.map((market) => ({
        low: market.range.low,
        high: market.range.high,
        probability: market.probability,
      })),
      excludedPathMarkets: classified.filter((market) => market.type === 'path').length,
    }
  }

  const thresholdMarkets = classified
    .filter((market) => market.type === 'threshold' && market.direction === 'above')
    .sort((a, b) => a.strike - b.strike)

  if (thresholdMarkets.length >= 2) {
    const bins = []
    for (let index = 0; index < thresholdMarkets.length; index++) {
      const current = thresholdMarkets[index]
      const next = thresholdMarkets[index + 1] ?? null
      const nextProbability = next ? next.probability : 0
      bins.push({
        low: current.strike,
        high: next?.strike ?? null,
        probability: roundProbability(current.probability - nextProbability),
      })
    }

    return {
      source: 'threshold',
      bins: bins.filter((bin) => bin.probability > 0),
      excludedPathMarkets: classified.filter((market) => market.type === 'path').length,
    }
  }

  return {
    source: 'none',
    bins: [],
    excludedPathMarkets: classified.filter((market) => market.type === 'path').length,
  }
}

export function summarizeDistribution(distribution, spotPrice) {
  const bins = distribution?.bins ?? []
  if (!bins.length || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return {
      expectedPrice: null,
      expectedMove: null,
      expectedMovePct: null,
      mostLikelyRange: null,
    }
  }

  const expectedPrice = bins.reduce((sum, bin) => {
    const midpoint = bin.high === null ? bin.low : (bin.low + bin.high) / 2
    return sum + midpoint * bin.probability
  }, 0)

  const mostLikelyRange = bins.reduce((best, bin) =>
    !best || bin.probability > best.probability ? bin : best
  , null)

  const expectedMove = Math.abs(expectedPrice - spotPrice)

  return {
    expectedPrice: Math.round(expectedPrice),
    expectedMove: Math.round(expectedMove),
    expectedMovePct: Number(((expectedMove / spotPrice) * 100).toFixed(2)),
    mostLikelyRange,
  }
}

export function summarizePathMarkets(markets = [], spotPrice) {
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    return {
      pathMovePct: null,
      pathMoveUsd: null,
      upsidePathPct: null,
      downsidePathPct: null,
      strongestUpsideBarrier: null,
      strongestDownsideBarrier: null,
    }
  }

  const classified = markets
    .map(toDistributionEntry)
    .filter((market) => market.type === 'path' && Number.isFinite(market.barrier))

  if (!classified.length) {
    return {
      pathMovePct: null,
      pathMoveUsd: null,
      upsidePathPct: null,
      downsidePathPct: null,
      strongestUpsideBarrier: null,
      strongestDownsideBarrier: null,
    }
  }

  let upsidePathPct = 0
  let downsidePathPct = 0
  let strongestUpsideBarrier = null
  let strongestDownsideBarrier = null
  let strongestUpsideProbability = -1
  let strongestDownsideProbability = -1

  const upsideMarkets = classified
    .filter((market) => Number(market.barrier) > spotPrice && market.direction !== 'below')
    .sort((a, b) => Number(a.barrier) - Number(b.barrier))

  for (let index = 0; index < upsideMarkets.length; index++) {
    const market = upsideMarkets[index]
    const nextProbability = index + 1 < upsideMarkets.length
      ? clampProbability(upsideMarkets[index + 1].probability)
      : 0
    const marginalProbability = Math.max(0, clampProbability(market.probability) - nextProbability)
    const barrier = Number(market.barrier)
    upsidePathPct += marginalProbability * ((barrier / spotPrice) - 1) * 100
    if (clampProbability(market.probability) > strongestUpsideProbability) {
      strongestUpsideProbability = clampProbability(market.probability)
      strongestUpsideBarrier = barrier
    }
  }

  const downsideMarkets = classified
    .filter((market) => Number(market.barrier) < spotPrice && market.direction === 'below')
    .sort((a, b) => Number(b.barrier) - Number(a.barrier))

  for (let index = 0; index < downsideMarkets.length; index++) {
    const market = downsideMarkets[index]
    const nextProbability = index + 1 < downsideMarkets.length
      ? clampProbability(downsideMarkets[index + 1].probability)
      : 0
    const marginalProbability = Math.max(0, clampProbability(market.probability) - nextProbability)
    const barrier = Number(market.barrier)
    downsidePathPct += marginalProbability * (1 - (barrier / spotPrice)) * 100
    if (clampProbability(market.probability) > strongestDownsideProbability) {
      strongestDownsideProbability = clampProbability(market.probability)
      strongestDownsideBarrier = barrier
    }
  }

  const pathMovePct = (upsidePathPct + downsidePathPct) / 2

  return {
    pathMovePct: Number(pathMovePct.toFixed(2)),
    pathMoveUsd: Math.round((pathMovePct / 100) * spotPrice),
    upsidePathPct: Number(upsidePathPct.toFixed(2)),
    downsidePathPct: Number(downsidePathPct.toFixed(2)),
    strongestUpsideBarrier,
    strongestDownsideBarrier,
  }
}
