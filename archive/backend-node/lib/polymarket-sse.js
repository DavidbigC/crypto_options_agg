function normalizeSpotPrice(value) {
  return Number(value) || 0
}

function makeGroupKey(asset, spotPrice) {
  return `${asset}:${spotPrice}`
}

export function createPolymarketSurfaceBroadcaster({
  service,
  clientsByKey,
  registerAssetTokens = () => {},
  subscribeAssetIds = () => {},
} = {}) {
  const inflight = new Map()

  async function fetchSurface(asset, spotPrice = 0) {
    const normalizedSpotPrice = normalizeSpotPrice(spotPrice)
    const cacheKey = makeGroupKey(asset, normalizedSpotPrice)
    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, (async () => {
        const surface = await service.getSurface({ asset, spotPrice: normalizedSpotPrice })
        registerAssetTokens(asset, surface)
        subscribeAssetIds(
          Object.values(surface?.horizons ?? {}).flatMap((horizon) =>
            (horizon?.sourceMarkets ?? [])
              .flatMap((market) => market.tokenIds ?? (market.tokenId ? [market.tokenId] : []))
              .filter(Boolean),
          ),
        )
        return surface
      })().finally(() => {
        inflight.delete(cacheKey)
      }))
    }
    return inflight.get(cacheKey)
  }

  async function broadcastAsset(asset) {
    const key = `polymarket:${asset}`
    const clients = clientsByKey.get(key)
    if (!clients?.size) return

    const groupedClients = new Map()
    for (const [res, opts] of clients.entries()) {
      if (res.writableEnded) {
        clients.delete(res)
        continue
      }
      const spotPrice = normalizeSpotPrice(opts?.spotPrice)
      const groupKey = makeGroupKey(asset, spotPrice)
      if (!groupedClients.has(groupKey)) groupedClients.set(groupKey, { spotPrice, responses: [] })
      groupedClients.get(groupKey).responses.push(res)
    }

    for (const { spotPrice, responses } of groupedClients.values()) {
      const surface = await fetchSurface(asset, spotPrice)
      const payload = `data: ${JSON.stringify(surface)}\n\n`
      for (const res of responses) {
        try {
          res.write(payload)
        } catch {
          clients.delete(res)
        }
      }
    }
  }

  return {
    fetchSurface,
    broadcastAsset,
  }
}
