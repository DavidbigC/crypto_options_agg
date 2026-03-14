import test from 'node:test'
import assert from 'node:assert/strict'

import { createPolymarketRouteHandler } from './lib/polymarket/service.js'

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

test('createPolymarketRouteHandler returns analysis payload for valid asset and horizon', async () => {
  const handler = createPolymarketRouteHandler({
    service: {
      getAnalysis: async ({ asset, horizon }) => ({ asset, horizon, ok: true }),
    },
  })
  const res = makeResponse()

  await handler({
    params: { asset: 'btc', horizon: 'weekly' },
    query: { spotPrice: '83000' },
  }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { asset: 'BTC', horizon: 'weekly', ok: true })
})

test('createPolymarketRouteHandler rejects invalid assets', async () => {
  const handler = createPolymarketRouteHandler({
    service: {
      getAnalysis: async () => {
        throw new Error('should not be called')
      },
    },
  })
  const res = makeResponse()

  await handler({
    params: { asset: 'doge', horizon: 'weekly' },
    query: {},
  }, res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /unsupported asset/i)
})

test('createPolymarketRouteHandler rejects invalid horizons', async () => {
  const handler = createPolymarketRouteHandler({
    service: {
      getAnalysis: async () => {
        throw new Error('should not be called')
      },
    },
  })
  const res = makeResponse()

  await handler({
    params: { asset: 'eth', horizon: 'quarterly' },
    query: {},
  }, res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /unsupported horizon/i)
})

test('createPolymarketRouteHandler returns backend errors as 503 responses', async () => {
  const handler = createPolymarketRouteHandler({
    service: {
      getAnalysis: async () => {
        throw new Error('Upstream unavailable')
      },
    },
  })
  const res = makeResponse()

  await handler({
    params: { asset: 'sol', horizon: 'monthly' },
    query: {},
  }, res)

  assert.equal(res.statusCode, 503)
  assert.match(res.body.error, /upstream unavailable/i)
})
