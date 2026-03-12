import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyPolymarketMarket,
  extractPolymarketAsset,
  extractPolymarketHorizon,
} from './lib/polymarket/normalize.js'

test('classifyPolymarketMarket detects threshold markets', () => {
  const result = classifyPolymarketMarket({
    question: 'Will Bitcoin be above $100,000 on March 31?',
  })

  assert.equal(result.type, 'threshold')
  assert.equal(result.direction, 'above')
  assert.equal(result.strike, 100000)
  assert.equal(result.confidence, 'high')
})

test('classifyPolymarketMarket detects range markets', () => {
  const result = classifyPolymarketMarket({
    question: 'Where will ETH close this week? $2,800-$3,000',
  })

  assert.equal(result.type, 'range')
  assert.deepEqual(result.range, { low: 2800, high: 3000 })
  assert.equal(result.confidence, 'high')
})

test('classifyPolymarketMarket detects path markets', () => {
  const result = classifyPolymarketMarket({
    question: 'Will SOL hit $250 in March?',
  })

  assert.equal(result.type, 'path')
  assert.equal(result.barrier, 250)
  assert.equal(result.confidence, 'high')
})

test('classifyPolymarketMarket rejects ambiguous titles', () => {
  const result = classifyPolymarketMarket({
    question: 'How high will BTC go this week?',
  })

  assert.equal(result.type, 'unknown')
  assert.equal(result.confidence, 'low')
  assert.match(result.reason, /ambiguous/i)
})

test('extractPolymarketAsset detects supported assets', () => {
  assert.equal(extractPolymarketAsset('Will Bitcoin be above $100,000 on March 31?'), 'BTC')
  assert.equal(extractPolymarketAsset('Where will ETH close this week?'), 'ETH')
  assert.equal(extractPolymarketAsset('Will Solana hit $250 in March?'), 'SOL')
})

test('extractPolymarketHorizon detects supported horizons', () => {
  assert.equal(extractPolymarketHorizon('Will BTC be above $90,000 today?'), 'daily')
  assert.equal(extractPolymarketHorizon('Where will ETH close this week?'), 'weekly')
  assert.equal(extractPolymarketHorizon('Will SOL hit $250 this month?'), 'monthly')
  assert.equal(extractPolymarketHorizon('Will Bitcoin be above $150,000 this year?'), 'yearly')
})
