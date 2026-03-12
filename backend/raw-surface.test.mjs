import assert from 'node:assert/strict'
import { computeAnalysis } from './lib/analysis.js'

const now = Date.now()
const oneDay = 24 * 60 * 60 * 1000

function formatExpiry(msOffset) {
  return new Date(now + msOffset).toISOString().slice(0, 10)
}

const futureExpiry = formatExpiry(30 * oneDay)
const pastExpiry = formatExpiry(-7 * oneDay)

const response = {
  expirations: [pastExpiry, futureExpiry],
  data: {
    [pastExpiry]: {
      calls: [{ strike: 110, markVol: 0.4 }],
      puts: [{ strike: 90, markVol: 0.45 }],
    },
    [futureExpiry]: {
      calls: [
        { strike: 100, markVol: 0.5 },
        { strike: 100.04, markVol: 0.52 },
        { strike: 108, markVol: 0.6 },
        { strike: 112, markVol: 0.4 },
        { strike: 92, markVol: 0.7 },
      ],
      puts: [
        { strike: 100, markVol: 0.55 },
        { strike: 99.96, markVol: 0.53 },
        { strike: 96, markVol: 0.5 },
        { strike: 88, markVol: 0.6 },
        { strike: 104, markVol: 0.9 },
      ],
    },
  },
}

const result = computeAnalysis(response, 100)

assert.ok(result, 'computeAnalysis should return analysis data')
assert.equal(typeof result.updatedAt, 'number', 'updatedAt should be present for freshness checks')
assert.ok(result.rawSurface, 'rawSurface should be present')
assert.equal(result.rawSurface.expiries.length, 1, 'past expiries should be excluded')
assert.equal(result.rawSurface.expiries[0].exp, futureExpiry, 'future expiry should be retained')

const bucketLabels = result.rawSurface.buckets.map(bucket => bucket.label)
assert.equal(new Set(bucketLabels).size, bucketLabels.length, 'raw surface bucket labels should be unique')
assert.equal(bucketLabels.filter(label => label === 'ATM').length, 1, 'only the exact spot bucket should be labeled ATM')

const atmCell = result.rawSurface.cells.find(cell => cell.exp === futureExpiry && cell.bucketLabel === 'ATM')
assert.ok(atmCell, 'ATM bucket should be present')
assert.equal(atmCell.count, 2, 'ATM bucket should aggregate both OTM ATM-side contracts')
assert.equal(atmCell.avgMarkIV, 52.5, 'ATM bucket should average raw mark IVs in percent')

const includedStrikes = result.rawSurface.cells.flatMap(cell => [cell.minStrike, cell.maxStrike])
assert.ok(!includedStrikes.includes(92), 'ITM call should not be included in raw surface')
assert.ok(!includedStrikes.includes(104), 'ITM put should not be included in raw surface')

assert.ok(Array.isArray(result.atmBboSpread), 'atmBboSpread should be an array')

// ATM BBO spread — separate fixture with bid/ask prices
const responseWithPrices = {
  expirations: [futureExpiry],
  data: {
    [futureExpiry]: {
      calls: [
        { strike: 98, bid: 200, ask: 220 },
        { strike: 100, bid: 500, ask: 540 },
        { strike: 102, bid: 300, ask: 330 },
      ],
      puts: [
        { strike: 98, bid: 280, ask: 310 },
        { strike: 100, bid: 490, ask: 530 },
        { strike: 102, bid: 700, ask: 740 },
      ],
    },
  },
}
const resultWithPrices = computeAnalysis(responseWithPrices, 100)
assert.ok(resultWithPrices.atmBboSpread.length === 1, 'atmBboSpread should have one entry for future expiry')
assert.equal(typeof resultWithPrices.atmBboSpread[0].spreadUsd, 'number', 'spreadUsd should be a number')
assert.equal(typeof resultWithPrices.atmBboSpread[0].spreadPct, 'number', 'spreadPct should be a number')
// ATM strike at spot=100 is strike 100. Call spread = 540-500=40, put spread = 530-490=40.
// avg mid = ((500+540)/2 + (490+530)/2) / 2 = (520+510)/2 = 515
// avg spread = (40+40)/2 = 40
// spreadPct = 40/515 * 100 ≈ 7.77
assert.equal(resultWithPrices.atmBboSpread[0].spreadUsd, 40)
assert.ok(Math.abs(resultWithPrices.atmBboSpread[0].spreadPct - 7.77) < 0.01, 'spreadPct should be ~7.77')

console.log('raw-surface.test: ok')
