import test from 'node:test'
import assert from 'node:assert/strict'

const { deriveCombinedAnalysis } = await import('./lib/liveCombinedAnalysis.js')

const now = Date.UTC(2099, 2, 10, 12, 0, 0)

const optionsData = {
  spotPrice: 100,
  expirations: ['2099-03-20', '2099-03-27'],
  expirationCounts: {
    '2099-03-20': { calls: 4, puts: 4 },
    '2099-03-27': { calls: 4, puts: 4 },
  },
  data: {
    '2099-03-20': {
      calls: [
        { strike: 100, delta: 0.48, markVol: 0.50, bestBid: 5, bestAsk: 6, prices: {} },
        { strike: 105, delta: 0.35, markVol: 0.52, bestBid: 3.7, bestAsk: 4.1, prices: {} },
        { strike: 110, delta: 0.24, markVol: 0.55, bestBid: 2.1, bestAsk: 2.5, prices: {} },
        { strike: 115, delta: 0.14, markVol: 0.59, bestBid: 1.2, bestAsk: 1.5, prices: {} },
      ],
      puts: [
        { strike: 100, delta: -0.52, markVol: 0.51, bestBid: 4, bestAsk: 5, prices: {} },
        { strike: 95, delta: -0.34, markVol: 0.54, bestBid: 3.1, bestAsk: 3.5, prices: {} },
        { strike: 90, delta: -0.26, markVol: 0.58, bestBid: 2.0, bestAsk: 2.4, prices: {} },
        { strike: 85, delta: -0.15, markVol: 0.63, bestBid: 1.1, bestAsk: 1.4, prices: {} },
      ],
    },
    '2099-03-27': {
      calls: [
        { strike: 100, delta: 0.47, markVol: 0.47, bestBid: 5.8, bestAsk: 6.4, prices: {} },
        { strike: 105, delta: 0.34, markVol: 0.49, bestBid: 4.1, bestAsk: 4.6, prices: {} },
        { strike: 110, delta: 0.25, markVol: 0.53, bestBid: 2.6, bestAsk: 3.1, prices: {} },
        { strike: 115, delta: 0.16, markVol: 0.57, bestBid: 1.5, bestAsk: 1.9, prices: {} },
      ],
      puts: [
        { strike: 100, delta: -0.51, markVol: 0.48, bestBid: 4.8, bestAsk: 5.5, prices: {} },
        { strike: 95, delta: -0.35, markVol: 0.51, bestBid: 3.5, bestAsk: 4.0, prices: {} },
        { strike: 90, delta: -0.24, markVol: 0.55, bestBid: 2.2, bestAsk: 2.7, prices: {} },
        { strike: 85, delta: -0.16, markVol: 0.60, bestBid: 1.2, bestAsk: 1.6, prices: {} },
      ],
    },
  },
}

test('deriveCombinedAnalysis produces live combined term, skew, spread, surface, and fit data', () => {
  const analysis = deriveCombinedAnalysis(optionsData, 100, now)

  assert.ok(analysis)
  assert.equal(analysis.updatedAt, now)
  assert.equal(analysis.termStructure.length, 2)
  assert.equal(analysis.skewData.length, 2)
  assert.equal(analysis.atmBboSpread.length, 2)
  assert.ok(analysis.rawSurface.cells.length > 0)
  assert.ok(analysis.sviFits['2099-03-20'])

  const firstTerm = analysis.termStructure[0]
  assert.equal(firstTerm.exp, '2099-03-20')
  assert.equal(firstTerm.label, 'Mar 20')
  assert.ok(firstTerm.atmIV > 40 && firstTerm.atmIV < 70)

  const firstSkew = analysis.skewData[0]
  assert.equal(firstSkew.exp, '2099-03-20')
  assert.ok(firstSkew.rr < 0, 'put skew should dominate call skew in the fixture')
  assert.ok(firstSkew.bf > 0)

  const firstSpread = analysis.atmBboSpread[0]
  assert.equal(firstSpread.exp, '2099-03-20')
  assert.equal(firstSpread.spreadUsd, 1)
  assert.equal(firstSpread.spreadPct, 20.2)

  const negativeWing = analysis.rawSurface.cells.find((cell) => cell.bucketKey < 0)
  const positiveWing = analysis.rawSurface.cells.find((cell) => cell.bucketKey > 0)
  assert.deepEqual(negativeWing?.optionTypes, ['put'])
  assert.deepEqual(positiveWing?.optionTypes, ['call'])
})
