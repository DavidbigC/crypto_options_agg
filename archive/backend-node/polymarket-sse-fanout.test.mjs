import test from 'node:test'
import assert from 'node:assert/strict'

import { createPolymarketSurfaceBroadcaster } from './lib/polymarket-sse.js'

function createResponse() {
  return {
    writableEnded: false,
    writes: [],
    write(chunk) {
      this.writes.push(chunk)
    },
  }
}

test('broadcastAsset computes once for multiple subscribers with the same spot price', async () => {
  let calls = 0
  const clientsByKey = new Map()
  const first = createResponse()
  const second = createResponse()
  clientsByKey.set('polymarket:BTC', new Map([
    [first, { spotPrice: 80000 }],
    [second, { spotPrice: 80000 }],
  ]))

  const broadcaster = createPolymarketSurfaceBroadcaster({
    service: {
      async getSurface({ asset, spotPrice }) {
        calls += 1
        return { asset, spotPrice, horizons: {} }
      },
    },
    clientsByKey,
  })

  await broadcaster.broadcastAsset('BTC')

  assert.equal(calls, 1)
  assert.equal(first.writes.length, 1)
  assert.equal(second.writes.length, 1)
  assert.equal(first.writes[0], second.writes[0])
})

test('broadcastAsset computes separately for different spot prices', async () => {
  const seen = []
  const clientsByKey = new Map()
  clientsByKey.set('polymarket:ETH', new Map([
    [createResponse(), { spotPrice: 3000 }],
    [createResponse(), { spotPrice: 3200 }],
  ]))

  const broadcaster = createPolymarketSurfaceBroadcaster({
    service: {
      async getSurface({ asset, spotPrice }) {
        seen.push({ asset, spotPrice })
        return { asset, spotPrice, horizons: {} }
      },
    },
    clientsByKey,
  })

  await broadcaster.broadcastAsset('ETH')

  assert.deepEqual(seen, [
    { asset: 'ETH', spotPrice: 3000 },
    { asset: 'ETH', spotPrice: 3200 },
  ])
})

test('fetchSurface reuses an in-flight computation for the same asset and spot price', async () => {
  let calls = 0
  const broadcaster = createPolymarketSurfaceBroadcaster({
    service: {
      async getSurface({ asset, spotPrice }) {
        calls += 1
        await Promise.resolve()
        return { asset, spotPrice, horizons: {} }
      },
    },
    clientsByKey: new Map(),
  })

  const [first, second] = await Promise.all([
    broadcaster.fetchSurface('SOL', 150),
    broadcaster.fetchSurface('SOL', 150),
  ])

  assert.equal(calls, 1)
  assert.deepEqual(first, second)
})
