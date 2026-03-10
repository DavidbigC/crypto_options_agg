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
        { strike: 108, markVol: 0.6 },
        { strike: 112, markVol: 0.4 },
        { strike: 92, markVol: 0.7 },
      ],
      puts: [
        { strike: 100, markVol: 0.55 },
        { strike: 96, markVol: 0.5 },
        { strike: 88, markVol: 0.6 },
        { strike: 104, markVol: 0.9 },
      ],
    },
  },
}

const result = computeAnalysis(response, 100)

assert.ok(result, 'computeAnalysis should return analysis data')
assert.ok(result.rawSurface, 'rawSurface should be present')
assert.equal(result.rawSurface.expiries.length, 1, 'past expiries should be excluded')
assert.equal(result.rawSurface.expiries[0].exp, futureExpiry, 'future expiry should be retained')

const atmCell = result.rawSurface.cells.find(cell => cell.exp === futureExpiry && cell.bucketLabel === 'ATM')
assert.ok(atmCell, 'ATM bucket should be present')
assert.equal(atmCell.count, 2, 'ATM bucket should aggregate both OTM ATM-side contracts')
assert.equal(atmCell.avgMarkIV, 52.5, 'ATM bucket should average raw mark IVs in percent')

const includedStrikes = result.rawSurface.cells.flatMap(cell => [cell.minStrike, cell.maxStrike])
assert.ok(!includedStrikes.includes(92), 'ITM call should not be included in raw surface')
assert.ok(!includedStrikes.includes(104), 'ITM put should not be included in raw surface')

console.log('raw-surface.test: ok')
