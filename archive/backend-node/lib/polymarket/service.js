import { createPolymarketClient } from './client.js'
import {
  buildDistributionFromMarkets,
  classifyPolymarketMarket,
  extractPolymarketAsset,
  extractPolymarketHorizon,
  summarizePathMarkets,
  summarizeDistribution,
} from './normalize.js'

function parseOpenInterest(rows = []) {
  const first = Array.isArray(rows) ? rows[0] : null
  const raw = first?.value ?? first?.open_interest ?? first?.openInterest ?? 0
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function parseOutcomeProbability(market = {}) {
  const raw = market.outcomePrices
  if (Array.isArray(raw) && raw.length) {
    const value = Number(raw[0])
    return Number.isFinite(value) ? value : null
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        const value = Number(parsed[0])
        return Number.isFinite(value) ? value : null
      }
    } catch {}
  }
  return null
}

function resolveTokenIds(market = {}) {
  if (Array.isArray(market.clobTokenIds) && market.clobTokenIds.length) {
    return market.clobTokenIds.map((tokenId) => String(tokenId)).filter(Boolean)
  }
  if (typeof market.clobTokenIds === 'string' && market.clobTokenIds.trim()) {
    try {
      const parsed = JSON.parse(market.clobTokenIds)
      if (Array.isArray(parsed) && parsed.length) return parsed.map((tokenId) => String(tokenId)).filter(Boolean)
    } catch {}
  }
  if (market.clobTokenId !== undefined && market.clobTokenId !== null) {
    return [String(market.clobTokenId)]
  }
  return []
}

function resolveLivePrice(tokenIds, referenceProbability, livePriceLookup) {
  const rawPrices = (Array.isArray(tokenIds) ? tokenIds : [])
    .map((tokenId) => {
      const value = livePriceLookup(tokenId)
      return Number.isFinite(value) ? Number(value) : Number.NaN
    })
    .filter((price) => Number.isFinite(price))

  const candidates = rawPrices.flatMap((price) => {
    const complement = Number((1 - price).toFixed(6))
    return [price, complement]
  })

  if (!candidates.length) return Number.NaN
  if (!Number.isFinite(referenceProbability)) return candidates[0]

  return candidates.reduce((best, price) => (
    Math.abs(price - referenceProbability) < Math.abs(best - referenceProbability) ? price : best
  ), candidates[0])
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

function formatMonthDay(timestamp) {
  const date = new Date(timestamp)
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase()
  const day = date.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'UTC' })
  return `${month} ${day}`
}

function buildSearchQuery(asset, horizon, now) {
  const assetQuery = ASSET_QUERY[asset] ?? asset.toLowerCase()
  if (horizon === 'daily') return `${assetQuery} on ${formatMonthDay(now)}`
  return `${assetQuery} ${horizon}`
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

  function groupScore(group) {
    return group.reduce((score, market) => {
      const type = classifyPolymarketMarket(market).type
      return score + (type === 'unknown' ? 0 : 1)
    }, 0)
  }

  const sortedGroups = Array.from(grouped.values()).sort((left, right) => {
    const scoreDelta = groupScore(right) - groupScore(left)
    if (scoreDelta !== 0) return scoreDelta
    const endDelta = eventEndTime(left[0]) - eventEndTime(right[0])
    if (endDelta !== 0) return endDelta
    const sizeDelta = right.length - left.length
    if (sizeDelta !== 0) return sizeDelta
    return 0
  })

  return sortedGroups[0] ?? []
}

export function createPolymarketService({
  client = createPolymarketClient(),
  minVolume = 100,
  minOpenInterest = 100,
  maxSpreadPct = 1,
  discoveryTtlMs = 5 * 60_000,
  metadataTtlMs = 5 * 60_000,
  livePriceLookup = () => null,
  now = () => Date.now(),
} = {}) {
  const selectedMarketsCache = new Map()
  const marketMetadataCache = new Map()

  async function getSelectedMarkets(asset, horizon) {
    const cacheKey = `${asset}:${horizon}`
    const cached = selectedMarketsCache.get(cacheKey)
    const currentNow = now()
    if (cached && cached.expiresAt > currentNow) {
      return cached.markets
    }

    const searchPayload = await client.searchGamma(buildSearchQuery(asset, horizon, currentNow), 25)
    const discoveredMarkets = flattenDiscoveredMarkets(searchPayload)
    const relevantMarkets = discoveredMarkets.filter((market) =>
      market.inferredAsset === asset
      && market.inferredHorizon === horizon
    )
    const selectedMarkets = selectNearestEventMarkets(relevantMarkets)
    selectedMarketsCache.set(cacheKey, {
      expiresAt: currentNow + discoveryTtlMs,
      markets: selectedMarkets,
    })
    return selectedMarkets
  }

  async function getOpenInterestValue(market) {
    const cacheKey = String(market.conditionId ?? market.id)
    const cached = marketMetadataCache.get(cacheKey)
    const currentNow = now()
    if (cached && cached.expiresAt > currentNow) {
      return cached.openInterest
    }

    const openInterestRows = await client.getOpenInterest(cacheKey)
    const openInterest = parseOpenInterest(openInterestRows)
    marketMetadataCache.set(cacheKey, {
      expiresAt: currentNow + metadataTtlMs,
      openInterest,
    })
    return openInterest
  }

  async function buildSourceMarkets(selectedMarkets) {
    const missingPriceTokenIds = selectedMarkets
      .filter((market) => {
        const tokenIds = resolveTokenIds(market)
        return !Number.isFinite(Number(market.lastTradePrice))
          && !Number.isFinite(parseOutcomeProbability(market))
          && !tokenIds.some((tokenId) => Number.isFinite(livePriceLookup(tokenId)))
      })
      .flatMap(resolveTokenIds)
      .filter(Boolean)

    let prices = {}
    if (missingPriceTokenIds.length) {
      try {
        prices = await client.getClobPrices(missingPriceTokenIds)
      } catch {
        prices = {}
      }
    }

    return Promise.all(selectedMarkets.map(async (market) => {
      const tokenIds = resolveTokenIds(market)
      const classification = classifyPolymarketMarket(market)
      const fallbackProbability = parseOutcomeProbability(market)
      const wsPrice = resolveLivePrice(tokenIds, Number.isFinite(fallbackProbability) ? fallbackProbability : Number(market.lastTradePrice), livePriceLookup)
      const gammaPrice = Number(market.lastTradePrice)
      const clobPrice = tokenIds.length
        ? tokenIds
          .map((tokenId) => Number(prices[tokenId]))
          .find((price) => Number.isFinite(price))
        : Number.NaN
      return {
        id: market.id,
        slug: market.slug ?? null,
        question: market.question ?? market.title ?? '',
        tokenId: tokenIds[0] ?? null,
        tokenIds,
        endDate: market.event?.endDate ?? market.endDate ?? null,
        lastTradePrice: Number.isFinite(wsPrice)
          ? wsPrice
          : Number.isFinite(gammaPrice)
            ? gammaPrice
            : Number.isFinite(fallbackProbability)
              ? Number(fallbackProbability)
              : Number.isFinite(clobPrice)
                ? clobPrice
                : 0,
        volumeNum: Number(market.volumeNum ?? market.volume ?? 0) || 0,
        openInterest: await getOpenInterestValue(market),
        spreadPct: Number(market.spreadPct ?? market.spread ?? 0) || 0,
        classification,
      }
    }))
  }

  async function getAnalysis({ asset, horizon, spotPrice }) {
    const selectedMarkets = await getSelectedMarkets(asset, horizon)
    const sourceMarkets = await buildSourceMarkets(selectedMarkets)
    const expiryDate = selectedMarkets
      .map((market) => market.event?.endDate ?? market.endDate ?? null)
      .find(Boolean) ?? null

    const eligibleMarkets = sourceMarkets.filter((market) =>
      market.volumeNum >= minVolume
      && market.openInterest >= minOpenInterest
      && market.spreadPct <= maxSpreadPct
      && market.classification.type !== 'unknown',
    )
    const pathMarkets = eligibleMarkets.filter((market) => market.classification.type === 'path')

    const distribution = buildDistributionFromMarkets(eligibleMarkets)
    const summary = summarizeDistribution(distribution, spotPrice)
    const pathSummary = summarizePathMarkets(pathMarkets, spotPrice)
    const confidence = buildConfidence(eligibleMarkets)

    return {
      asset,
      horizon,
      expiryDate,
      distribution,
      summary,
      confidence,
      pathSummary,
      repricing: {
        change24h: null,
        change7d: null,
      },
      sourceMarkets,
      eligibleMarkets,
      pathMarkets,
    }
  }

  return {
    getAnalysis,
    async getSurface({ asset, spotPrice }) {
      const horizons = await Promise.all(
        Array.from(SUPPORTED_HORIZONS).map(async (horizon) => [horizon, await getAnalysis({ asset, horizon, spotPrice })]),
      )
      return {
        asset,
        generatedAt: new Date(now()).toISOString(),
        horizons: Object.fromEntries(horizons),
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

export function createPolymarketSurfaceRouteHandler({ service = createPolymarketService() } = {}) {
  return async function polymarketSurfaceRouteHandler(req, res) {
    const asset = String(req.params?.asset ?? '').toUpperCase()
    const spotPrice = Number(req.query?.spotPrice ?? 0) || 0

    if (!SUPPORTED_ASSETS.has(asset)) {
      return res.status(400).json({ error: `Unsupported asset: ${asset || 'unknown'}` })
    }

    try {
      const payload = await service.getSurface({ asset, spotPrice })
      return res.json(payload)
    } catch (error) {
      return res.status(503).json({
        error: error instanceof Error ? error.message : 'Polymarket surface unavailable',
      })
    }
  }
}
