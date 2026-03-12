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
  const raw = first?.value ?? first?.open_interest ?? first?.openInterest ?? 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function resolveTokenId(market = {}) {
  if (Array.isArray(market.clobTokenIds) && market.clobTokenIds.length) {
    return String(market.clobTokenIds[0])
  }
  if (typeof market.clobTokenIds === 'string' && market.clobTokenIds.trim()) {
    try {
      const parsed = JSON.parse(market.clobTokenIds)
      if (Array.isArray(parsed) && parsed.length) return String(parsed[0])
    } catch {}
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

const SUPPORTED_ASSETS = new Set(['BTC', 'ETH', 'SOL'])
const SUPPORTED_HORIZONS = new Set(['daily', 'weekly', 'monthly', 'yearly'])
const ASSET_QUERY = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
}

function inferAssetFromEvent(event = {}, market = {}) {
  const tagSlugs = Array.isArray(event.tags) ? event.tags.map((tag) => String(tag.slug ?? '').toLowerCase()) : []
  const texts = [
    event.slug,
    event.title,
    market.slug,
    market.question,
  ].map((value) => String(value ?? ''))

  if (tagSlugs.includes('bitcoin') || texts.some((value) => /\b(?:btc|bitcoin)\b/i.test(value))) return 'BTC'
  if (tagSlugs.includes('ethereum') || texts.some((value) => /\b(?:eth|ethereum)\b/i.test(value))) return 'ETH'
  if (tagSlugs.includes('solana') || texts.some((value) => /\b(?:sol|solana)\b/i.test(value))) return 'SOL'
  return extractPolymarketAsset(`${event.title ?? ''} ${market.question ?? ''}`)
}

function inferHorizonFromEvent(event = {}, market = {}) {
  const tagSlugs = Array.isArray(event.tags) ? event.tags.map((tag) => String(tag.slug ?? '').toLowerCase()) : []
  if (tagSlugs.includes('daily')) return 'daily'
  if (tagSlugs.includes('weekly')) return 'weekly'
  if (tagSlugs.includes('monthly')) return 'monthly'
  if (tagSlugs.includes('yearly')) return 'yearly'

  const seriesSlug = String(event.seriesSlug ?? event.slug ?? '')
  if (/daily/i.test(seriesSlug)) return 'daily'
  if (/weekly/i.test(seriesSlug)) return 'weekly'
  if (/monthly/i.test(seriesSlug)) return 'monthly'
  if (/yearly/i.test(seriesSlug)) return 'yearly'

  return extractPolymarketHorizon(`${event.title ?? ''} ${market.question ?? ''}`)
}

function flattenDiscoveredMarkets(searchPayload) {
  const events = Array.isArray(searchPayload?.events) ? searchPayload.events : []
  return events.flatMap((event) =>
    (Array.isArray(event.markets) ? event.markets : []).map((market) => ({
      ...market,
      event,
      inferredAsset: inferAssetFromEvent(event, market),
      inferredHorizon: inferHorizonFromEvent(event, market),
    })),
  )
}

function isOpenMarket(market) {
  return market.active !== false && market.closed !== true && market.event?.active !== false && market.event?.closed !== true
}

function eventEndTime(market) {
  const raw = market.event?.endDate ?? market.endDate ?? null
  const timestamp = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY
}

function selectNearestEventMarkets(markets) {
  const openMarkets = markets.filter(isOpenMarket)
  if (!openMarkets.length) return []

  const grouped = new Map()
  for (const market of openMarkets) {
    const eventSlug = String(market.event?.slug ?? market.event?.id ?? market.slug ?? market.id)
    if (!grouped.has(eventSlug)) grouped.set(eventSlug, [])
    grouped.get(eventSlug).push(market)
  }

  const sortedGroups = Array.from(grouped.values()).sort((left, right) => {
    return eventEndTime(left[0]) - eventEndTime(right[0])
  })

  return sortedGroups[0] ?? []
}

export function createPolymarketService({
  client = createPolymarketClient(),
  minVolume = 100,
  minOpenInterest = 100,
  maxSpreadPct = 1,
} = {}) {
  return {
    async getAnalysis({ asset, horizon, spotPrice }) {
      const searchPayload = await client.searchGamma(ASSET_QUERY[asset] ?? asset.toLowerCase(), 25)
      const discoveredMarkets = flattenDiscoveredMarkets(searchPayload)
      const relevantMarkets = discoveredMarkets.filter((market) =>
        market.inferredAsset === asset
        && market.inferredHorizon === horizon
      )
      const selectedMarkets = selectNearestEventMarkets(relevantMarkets)

      const tokenIds = selectedMarkets
        .map(resolveTokenId)
        .filter(Boolean)

      const missingPriceTokenIds = selectedMarkets
        .filter((market) => !(Number.isFinite(Number(market.lastTradePrice)) && Number(market.lastTradePrice) > 0))
        .map(resolveTokenId)
        .filter(Boolean)

      const prices = missingPriceTokenIds.length ? await client.getClobPrices(missingPriceTokenIds) : {}

      const sourceMarkets = await Promise.all(selectedMarkets.map(async (market) => {
        const tokenId = resolveTokenId(market)
        const openInterestRows = await client.getOpenInterest(market.conditionId ?? market.id)
        const classification = classifyPolymarketMarket(market)
        return {
          id: market.id,
          slug: market.slug ?? null,
          question: market.question ?? market.title ?? '',
          tokenId,
          lastTradePrice: Number.isFinite(Number(market.lastTradePrice)) && Number(market.lastTradePrice) > 0
            ? Number(market.lastTradePrice)
            : tokenId
              ? Number(prices[tokenId] ?? 0)
              : 0,
          volumeNum: Number(market.volumeNum ?? market.volume ?? 0) || 0,
          openInterest: parseOpenInterest(openInterestRows),
          spreadPct: Number(market.spreadPct ?? market.spread ?? 0) || 0,
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

export function createPolymarketRouteHandler({ service = createPolymarketService() } = {}) {
  return async function polymarketRouteHandler(req, res) {
    const asset = String(req.params?.asset ?? '').toUpperCase()
    const horizon = String(req.params?.horizon ?? '').toLowerCase()
    const spotPrice = Number(req.query?.spotPrice ?? 0) || 0

    if (!SUPPORTED_ASSETS.has(asset)) {
      return res.status(400).json({ error: `Unsupported asset: ${asset || 'unknown'}` })
    }

    if (!SUPPORTED_HORIZONS.has(horizon)) {
      return res.status(400).json({ error: `Unsupported horizon: ${horizon || 'unknown'}` })
    }

    try {
      const payload = await service.getAnalysis({ asset, horizon, spotPrice })
      return res.json(payload)
    } catch (error) {
      return res.status(503).json({
        error: error instanceof Error ? error.message : 'Polymarket data unavailable',
      })
    }
  }
}
