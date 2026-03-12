import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPolymarketClient,
  assertGammaMarketsResponse,
  assertGammaSearchResponse,
} from './lib/polymarket/client.js'

test('createPolymarketClient builds a Gamma markets request with query params', async () => {
  const seen = []
  const client = createPolymarketClient({
    fetchImpl: async (url, options) => {
      seen.push({ url, options })
      return {
        ok: true,
        status: 200,
        json: async () => ([]),
      }
    },
  })

  await client.getGammaMarkets({
    limit: 25,
    closed: false,
    tagId: 100639,
    endDateMin: '2026-03-12T00:00:00Z',
  })

  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /^https:\/\/gamma-api\.polymarket\.com\/markets\?/)
  assert.match(seen[0].url, /limit=25/)
  assert.match(seen[0].url, /closed=false/)
  assert.match(seen[0].url, /tag_id=100639/)
  assert.match(seen[0].url, /end_date_min=2026-03-12T00%3A00%3A00Z/)
  assert.equal(seen[0].options.headers['User-Agent'], 'polysis/1.0')
})

test('createPolymarketClient builds a CLOB prices request from token ids', async () => {
  const seen = []
  const client = createPolymarketClient({
    fetchImpl: async (url) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      }
    },
  })

  await client.getClobPrices(['1', '2', '3'])

  assert.equal(seen.length, 1)
  assert.equal(seen[0], 'https://clob.polymarket.com/prices?token_ids=1%2C2%2C3')
})

test('createPolymarketClient builds a Data API open interest request', async () => {
  const seen = []
  const client = createPolymarketClient({
    fetchImpl: async (url) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ([]),
      }
    },
  })

  await client.getOpenInterest('market-123')

  assert.equal(seen[0], 'https://data-api.polymarket.com/oi?market=market-123')
})

test('createPolymarketClient builds a Gamma public search request', async () => {
  const seen = []
  const client = createPolymarketClient({
    fetchImpl: async (url) => {
      seen.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: [], pagination: { hasMore: false, totalResults: 0 } }),
      }
    },
  })

  await client.searchGamma('bitcoin', 5)

  assert.equal(seen[0], 'https://gamma-api.polymarket.com/public-search?q=bitcoin&limit_per_type=5')
})

test('assertGammaMarketsResponse rejects non-array payloads', () => {
  assert.throws(
    () => assertGammaMarketsResponse({ data: [] }),
    /expected gamma markets response to be an array/i,
  )
})

test('assertGammaSearchResponse rejects payloads without an events array', () => {
  assert.throws(
    () => assertGammaSearchResponse([]),
    /expected gamma search response to have an events array/i,
  )
})

test('createPolymarketClient raises normalized errors for non-ok responses', async () => {
  const client = createPolymarketClient({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'upstream unavailable' }),
    }),
  })

  await assert.rejects(
    () => client.getGammaMarkets({ limit: 5 }),
    /gamma request failed with http 503/i,
  )
})
