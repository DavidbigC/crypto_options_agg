import { createPolymarketClient } from './client.js'
import {
  buildDistributionFromMarkets,
  classifyPolymarketMarket,
  extractPolymarketAsset,
  extractPolymarketHorizon,
  summarizeDistribution,
} from './normalize.js'

function parseOpenInterest(rows = []) {
  const first = Array.isArray(rows) ? rows[0] : null
  const raw = first?.open_interest ?? first?.openInterest ?? 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function resolveTokenId(market = {}) {
  if (Array.isArray(market.clobTokenIds) && market.clobTokenIds.length) {
    return String(market.clobTokenIds[0])
  }
  if (market.clobTokenId !== undefined && market.clobTokenId !== null) {
    return String(market.clobTokenId)
  }
  return null
}

function confidenceLabel(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

function buildConfidence(eligibleMarkets) {
  const totalVolume = eligibleMarkets.reduce((sum, market) => sum + market.volumeNum, 0)
  const totalOpenInterest = eligibleMarkets.reduce((sum, market) => sum + market.openInterest, 0)
  const marketCount = eligibleMarkets.length
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        Math.min(40, totalVolume / 5000)
        + Math.min(40, totalOpenInterest / 5000)
        + Math.min(20, marketCount * 10),
      ),
    ),
  )

  return {
    score,
    label: confidenceLabel(score),
    marketCount,
    totalVolume,
    totalOpenInterest,
  }
}

export function createPolymarketService({
  client = createPolymarketClient(),
  minVolume = 100,
  minOpenInterest = 100,
  maxSpreadPct = 1,
} = {}) {
  return {
    async getAnalysis({ asset, horizon, spotPrice }) {
      const discoveredMarkets = await client.getGammaMarkets({ limit: 200, closed: false })
      const relevantMarkets = discoveredMarkets.filter((market) =>
        extractPolymarketAsset(market.question ?? market.title ?? '') === asset
        && extractPolymarketHorizon(market.question ?? market.title ?? '') === horizon,
      )

      const tokenIds = relevantMarkets
        .map(resolveTokenId)
        .filter(Boolean)

      const prices = tokenIds.length ? await client.getClobPrices(tokenIds) : {}

      const sourceMarkets = await Promise.all(relevantMarkets.map(async (market) => {
        const tokenId = resolveTokenId(market)
        const openInterestRows = await client.getOpenInterest(market.id)
        const classification = classifyPolymarketMarket(market)
        return {
          id: market.id,
          question: market.question ?? market.title ?? '',
          tokenId,
          lastTradePrice: tokenId ? Number(prices[tokenId] ?? 0) : 0,
          volumeNum: Number(market.volumeNum ?? market.volume ?? 0) || 0,
          openInterest: parseOpenInterest(openInterestRows),
          spreadPct: Number(market.spreadPct ?? 0) || 0,
          classification,
        }
      }))

      const eligibleMarkets = sourceMarkets.filter((market) =>
        market.volumeNum >= minVolume
        && market.openInterest >= minOpenInterest
        && market.spreadPct <= maxSpreadPct
        && market.classification.type !== 'unknown',
      )

      const distribution = buildDistributionFromMarkets(eligibleMarkets)
      const summary = summarizeDistribution(distribution, spotPrice)
      const confidence = buildConfidence(eligibleMarkets)

      return {
        asset,
        horizon,
        distribution,
        summary,
        confidence,
        repricing: {
          change24h: null,
          change7d: null,
        },
        sourceMarkets,
        eligibleMarkets,
      }
    },
  }
}
