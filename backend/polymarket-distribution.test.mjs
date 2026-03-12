import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDistributionFromMarkets,
  summarizeDistribution,
} from './lib/polymarket/normalize.js'

test('buildDistributionFromMarkets uses non-overlapping range bins as the primary PMF', () => {
  const distribution = buildDistributionFromMarkets([
    { question: 'Where will BTC close this week? $80k-$82k', lastTradePrice: 0.2 },
    { question: 'Where will BTC close this week? $82k-$84k', lastTradePrice: 0.5 },
    { question: 'Where will BTC close this week? $84k-$86k', lastTradePrice: 0.3 },
  ])

  assert.deepEqual(distribution.bins, [
    { low: 80000, high: 82000, probability: 0.2 },
    { low: 82000, high: 84000, probability: 0.5 },
    { low: 84000, high: 86000, probability: 0.3 },
  ])
  assert.equal(distribution.source, 'range')
})

test('buildDistributionFromMarkets approximates a PMF from threshold markets when ranges are absent', () => {
  const distribution = buildDistributionFromMarkets([
    { question: 'Will BTC be above $80k this week?', lastTradePrice: 0.9 },
    { question: 'Will BTC be above $82k this week?', lastTradePrice: 0.6 },
    { question: 'Will BTC be above $84k this week?', lastTradePrice: 0.25 },
  ])

  assert.deepEqual(distribution.bins, [
    { low: 80000, high: 82000, probability: 0.3 },
    { low: 82000, high: 84000, probability: 0.35 },
    { low: 84000, high: null, probability: 0.25 },
  ])
  assert.equal(distribution.source, 'threshold')
})

test('buildDistributionFromMarkets excludes path markets from the terminal PMF', () => {
  const distribution = buildDistributionFromMarkets([
    { question: 'Will SOL hit $250 this month?', lastTradePrice: 0.4 },
    { question: 'Where will SOL close this month? $180-$200', lastTradePrice: 0.7 },
    { question: 'Where will SOL close this month? $200-$220', lastTradePrice: 0.3 },
  ])

  assert.deepEqual(distribution.bins, [
    { low: 180, high: 200, probability: 0.7 },
    { low: 200, high: 220, probability: 0.3 },
  ])
  assert.equal(distribution.excludedPathMarkets, 1)
})

test('summarizeDistribution returns expected price, expected move, and most likely range', () => {
  const summary = summarizeDistribution({
    bins: [
      { low: 80000, high: 82000, probability: 0.2 },
      { low: 82000, high: 84000, probability: 0.5 },
      { low: 84000, high: 86000, probability: 0.3 },
    ],
  }, 83000)

  assert.equal(summary.expectedPrice, 83200)
  assert.equal(summary.expectedMove, 200)
  assert.equal(summary.expectedMovePct, 0.24)
  assert.deepEqual(summary.mostLikelyRange, { low: 82000, high: 84000, probability: 0.5 })
})
