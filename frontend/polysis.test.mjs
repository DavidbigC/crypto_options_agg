import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPolysisExpirySeries,
  buildPolysisDistributionChartData,
  formatPolysisConfidence,
  mapPolymarketResponse,
  mapPolymarketSurface,
} from './lib/polysis.js'

test('mapPolymarketResponse preserves the expected core shape', () => {
  const result = mapPolymarketResponse({
    asset: 'BTC',
    horizon: 'weekly',
    distribution: {
      source: 'range',
      bins: [
        { low: 80000, high: 82000, probability: 0.4 },
        { low: 82000, high: 84000, probability: 0.6 },
      ],
    },
    summary: {
      expectedPrice: 82200,
      expectedMove: 800,
      expectedMovePct: 0.96,
      mostLikelyRange: { low: 82000, high: 84000, probability: 0.6 },
    },
    confidence: {
      score: 78,
      label: 'high',
    },
    pathSummary: {
      pathMovePct: 8.75,
      pathMoveUsd: 7000,
      upsidePathPct: 5,
      downsidePathPct: 3.75,
      strongestUpsideBarrier: 90000,
      strongestDownsideBarrier: 70000,
    },
    repricing: {
      change24h: null,
      change7d: null,
    },
    sourceMarkets: [
      { id: 'm1', question: 'Where will BTC close this week? $80k-$82k', classification: { type: 'range' } },
    ],
  })

  assert.equal(result.asset, 'BTC')
  assert.equal(result.horizon, 'weekly')
  assert.equal(result.summary.expectedPrice, 82200)
  assert.equal(result.pathSummary.pathMovePct, 8.75)
  assert.equal(result.sourceMarkets[0].classification.type, 'range')
})

test('buildPolysisDistributionChartData maps bins into UI-friendly rows', () => {
  const rows = buildPolysisDistributionChartData({
    bins: [
      { low: 80000, high: 82000, probability: 0.4 },
      { low: 82000, high: 84000, probability: 0.6 },
      { low: 84000, high: null, probability: 0.1 },
    ],
  })

  assert.deepEqual(rows, [
    { label: '$80,000-$82,000', low: 80000, high: 82000, probability: 40 },
    { label: '$82,000-$84,000', low: 82000, high: 84000, probability: 60 },
    { label: '$84,000+', low: 84000, high: null, probability: 10 },
  ])
})

test('formatPolysisConfidence returns a compact UI label', () => {
  assert.equal(formatPolysisConfidence({ score: 78, label: 'high' }), 'High confidence (78/100)')
  assert.equal(formatPolysisConfidence({ score: 42, label: 'medium' }), 'Medium confidence (42/100)')
  assert.equal(formatPolysisConfidence(null), 'Confidence unavailable')
})

test('buildPolysisExpirySeries prefers path move and sorts by expiry date', () => {
  const rows = buildPolysisExpirySeries([
    {
      asset: 'BTC',
      horizon: 'yearly',
      expiryDate: '2026-12-31T16:00:00Z',
      pathSummary: { pathMovePct: 35, upsidePathPct: 20, downsidePathPct: 15 },
      summary: { expectedMovePct: 18 },
      confidence: { marketCount: 12 },
    },
    {
      asset: 'BTC',
      horizon: 'weekly',
      expiryDate: '2026-03-12T16:00:00Z',
      pathSummary: null,
      summary: { expectedMovePct: 2.4 },
      confidence: { marketCount: 9 },
    },
  ])

  assert.equal(rows.length, 2)
  assert.equal(rows[0].horizon, 'weekly')
  assert.equal(rows[0].movePct, 2.4)
  assert.equal(rows[0].signalType, 'terminal')
  assert.equal(rows[1].movePct, 35)
  assert.equal(rows[1].upPct, 20)
  assert.equal(rows[1].downPct, 15)
  assert.equal(rows[1].signalType, 'path')
})

test('mapPolymarketSurface maps each horizon through the response mapper', () => {
  const result = mapPolymarketSurface({
    asset: 'BTC',
    generatedAt: '2026-03-12T10:00:00Z',
    horizons: {
      weekly: {
        asset: 'BTC',
        horizon: 'weekly',
        expiryDate: '2026-03-16T04:00:00Z',
        distribution: { source: 'none', bins: [] },
        summary: { expectedMovePct: 4.2 },
        pathSummary: { pathMovePct: 4.65 },
        confidence: { score: 80, label: 'high' },
        repricing: { change24h: null, change7d: null },
        sourceMarkets: [],
      },
    },
  })

  assert.equal(result.asset, 'BTC')
  assert.equal(result.generatedAt, '2026-03-12T10:00:00Z')
  assert.equal(result.horizons.weekly.pathSummary.pathMovePct, 4.65)
  assert.equal(result.horizons.daily, null)
})
