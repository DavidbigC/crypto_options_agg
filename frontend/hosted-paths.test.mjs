import test from 'node:test'
import assert from 'node:assert/strict'

import { apiPath, ssePath } from './lib/apiBase.js'

test('apiPath returns deploy-safe relative api paths', () => {
  assert.equal(apiPath('/api/optimizer/BTC'), '/api/optimizer/BTC')
  assert.equal(apiPath('api/portfolio/okx'), '/api/portfolio/okx')
  assert.equal(apiPath('stream/combined/BTC'), '/api/stream/combined/BTC')
})

test('ssePath returns deploy-safe relative stream paths', () => {
  assert.equal(ssePath('/api/stream/bybit/BTC'), '/api/stream/bybit/BTC')
  assert.equal(ssePath('stream/polymarket/BTC?spotPrice=80000'), '/api/stream/polymarket/BTC?spotPrice=80000')
})
