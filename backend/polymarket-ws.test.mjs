import test from 'node:test'
import assert from 'node:assert/strict'

import { extractPolymarketWsUpdates } from './lib/polymarket/ws.js'

test('extractPolymarketWsUpdates reads direct price payloads', () => {
  const updates = extractPolymarketWsUpdates({
    asset_id: '123',
    price: '0.42',
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0].assetId, '123')
  assert.equal(updates[0].price, 0.42)
})

test('extractPolymarketWsUpdates derives a midpoint from book payloads', () => {
  const updates = extractPolymarketWsUpdates({
    asset_id: '456',
    buys: [{ price: '0.40' }],
    sells: [{ price: '0.44' }],
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0].price, 0.42)
})
