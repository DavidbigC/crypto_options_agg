import assert from 'node:assert/strict'

import { groupSurfaceBuckets } from './surfaceGrouping.js'

const baseSurface = {
  expiries: [
    { exp: '2026-03-20', label: 'Mar 20', dte: 8 },
    { exp: '2026-03-27', label: 'Mar 27', dte: 15 },
  ],
  buckets: [
    { key: -0.12, label: '-11.3%', moneynessPct: -11.3 },
    { key: -0.04, label: '-3.9%', moneynessPct: -3.9 },
    { key: 0, label: 'ATM', moneynessPct: 0 },
    { key: 0.05, label: '+5.1%', moneynessPct: 5.1 },
  ],
  cells: [
    { exp: '2026-03-20', label: 'Mar 20', dte: 8, bucketKey: -0.12, bucketLabel: '-11.3%', moneynessPct: -11.3, avgMarkIV: 60, count: 2, minStrike: 60000, maxStrike: 61000, optionTypes: ['put'] },
    { exp: '2026-03-20', label: 'Mar 20', dte: 8, bucketKey: -0.04, bucketLabel: '-3.9%', moneynessPct: -3.9, avgMarkIV: 56, count: 1, minStrike: 62000, maxStrike: 62000, optionTypes: ['put'] },
    { exp: '2026-03-20', label: 'Mar 20', dte: 8, bucketKey: 0, bucketLabel: 'ATM', moneynessPct: 0, avgMarkIV: 52, count: 3, minStrike: 63000, maxStrike: 63500, optionTypes: ['call', 'put'] },
    { exp: '2026-03-20', label: 'Mar 20', dte: 8, bucketKey: 0.05, bucketLabel: '+5.1%', moneynessPct: 5.1, avgMarkIV: 50, count: 2, minStrike: 64000, maxStrike: 65000, optionTypes: ['call'] },
    { exp: '2026-03-27', label: 'Mar 27', dte: 15, bucketKey: 0, bucketLabel: 'ATM', moneynessPct: 0, avgMarkIV: 54, count: 1, minStrike: 63000, maxStrike: 63000, optionTypes: ['call', 'put'] },
  ],
}

const unchanged = groupSurfaceBuckets(baseSurface, 6)
assert.equal(unchanged.buckets.length, 4, 'surface should remain unchanged when already under the cap')
assert.deepEqual(unchanged.buckets.map(bucket => bucket.label), baseSurface.buckets.map(bucket => bucket.label))
assert.equal(unchanged.cells.length, baseSurface.cells.length, 'ungrouped cells should be preserved when no grouping is needed')

const twentyFiveBucketSurface = {
  expiries: [{ exp: '2026-03-20', label: 'Mar 20', dte: 8 }],
  buckets: Array.from({ length: 25 }, (_, index) => ({
    key: index - 12,
    label: `B${index + 1}`,
    moneynessPct: index - 12,
  })),
  cells: Array.from({ length: 25 }, (_, index) => ({
    exp: '2026-03-20',
    label: 'Mar 20',
    dte: 8,
    bucketKey: index - 12,
    bucketLabel: `B${index + 1}`,
    moneynessPct: index - 12,
    avgMarkIV: 40 + index,
    count: 1,
    minStrike: 50000 + index * 1000,
    maxStrike: 50000 + index * 1000,
    optionTypes: ['call'],
  })),
}

const cappedAtTwentyFive = groupSurfaceBuckets(twentyFiveBucketSurface)
assert.equal(cappedAtTwentyFive.buckets.length, 25, 'default fit cap should allow 25 raw buckets before grouping')

const grouped = groupSurfaceBuckets(baseSurface, 2)
assert.equal(grouped.buckets.length, 2, 'surface should collapse to the requested adjacent bucket cap')
assert.deepEqual(grouped.buckets.map(bucket => bucket.label), ['-11.3% to -3.9%', 'ATM to +5.1%'])

const firstBucketCell = grouped.cells.find(cell => cell.exp === '2026-03-20' && cell.bucketLabel === '-11.3% to -3.9%')
assert.ok(firstBucketCell, 'first grouped bucket should have a merged cell for Mar 20')
assert.equal(firstBucketCell.avgMarkIV, 58.7, 'grouped IV should be weighted by source cell counts')
assert.equal(firstBucketCell.count, 3, 'grouped cell count should sum source counts')
assert.equal(firstBucketCell.minStrike, 60000, 'grouped cell should preserve minimum strike across members')
assert.equal(firstBucketCell.maxStrike, 62000, 'grouped cell should preserve maximum strike across members')
assert.deepEqual(firstBucketCell.optionTypes, ['put'], 'grouped cell should merge option types without duplication')

const secondBucketCell = grouped.cells.find(cell => cell.exp === '2026-03-20' && cell.bucketLabel === 'ATM to +5.1%')
assert.ok(secondBucketCell, 'second grouped bucket should have a merged cell for Mar 20')
assert.equal(secondBucketCell.avgMarkIV, 51.2)
assert.equal(secondBucketCell.count, 5)
assert.deepEqual(secondBucketCell.optionTypes, ['call', 'put'])

const sparseCell = grouped.cells.find(cell => cell.exp === '2026-03-27' && cell.bucketLabel === 'ATM to +5.1%')
assert.ok(sparseCell, 'grouping should preserve expiries even when only one member cell contributes')
assert.equal(sparseCell.avgMarkIV, 54)
assert.equal(sparseCell.count, 1)

console.log('surfaceGrouping.test: ok')
