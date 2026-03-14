import assert from 'node:assert/strict'

import {
  buildTermStructureChartData,
  buildSkewChartData,
  buildSurfaceComparison,
  getDatasetFreshness,
} from './analysisComparison.js'

const datasets = {
  combined: {
    updatedAt: Date.UTC(2026, 2, 11, 11, 0, 0),
    termStructure: [
      { exp: '2026-03-20', label: 'Mar 20', dte: 9, atmIV: 53.4 },
      { exp: '2026-03-27', label: 'Mar 27', dte: 16, atmIV: 48.7 },
    ],
    skewData: [
      { exp: '2026-03-20', label: 'Mar 20', rr: -6.1, bf: 1.83 },
      { exp: '2026-03-27', label: 'Mar 27', rr: -6.07, bf: 1.43 },
    ],
    rawSurface: {
      expiries: [
        { exp: '2026-03-20', label: 'Mar 20', dte: 9 },
      ],
      buckets: [
        { key: -0.05, label: '-5%', moneynessPct: -4.9 },
        { key: 0, label: 'ATM', moneynessPct: 0 },
      ],
      cells: [
        { exp: '2026-03-20', bucketKey: -0.05, avgMarkIV: 57.6, count: 3, label: 'Mar 20', dte: 9, bucketLabel: '-5%', moneynessPct: -4.9, minStrike: 65000, maxStrike: 67000, optionTypes: ['put'] },
        { exp: '2026-03-20', bucketKey: 0, avgMarkIV: 53.4, count: 4, label: 'Mar 20', dte: 9, bucketLabel: 'ATM', moneynessPct: 0, minStrike: 68000, maxStrike: 71000, optionTypes: ['call', 'put'] },
      ],
    },
  },
  deribit: {
    updatedAt: Date.UTC(2026, 2, 11, 10, 59, 50),
    termStructure: [
      { exp: '2026-03-20', label: 'Mar 20', dte: 9, atmIV: 53.2 },
      { exp: '2026-03-27', label: 'Mar 27', dte: 16, atmIV: 52.8 },
    ],
    skewData: [
      { exp: '2026-03-20', label: 'Mar 20', rr: -6.72, bf: 1.31 },
      { exp: '2026-03-27', label: 'Mar 27', rr: -6.91, bf: 1.32 },
    ],
    rawSurface: {
      expiries: [
        { exp: '2026-03-20', label: 'Mar 20', dte: 9 },
      ],
      buckets: [
        { key: -0.05, label: '-5%', moneynessPct: -4.9 },
        { key: 0, label: 'ATM', moneynessPct: 0 },
      ],
      cells: [
        { exp: '2026-03-20', bucketKey: -0.05, avgMarkIV: 56.7, count: 3, label: 'Mar 20', dte: 9, bucketLabel: '-5%', moneynessPct: -4.9, minStrike: 65000, maxStrike: 67000, optionTypes: ['put'] },
        { exp: '2026-03-20', bucketKey: 0, avgMarkIV: 52.9, count: 4, label: 'Mar 20', dte: 9, bucketLabel: 'ATM', moneynessPct: 0, minStrike: 68000, maxStrike: 71000, optionTypes: ['call', 'put'] },
      ],
    },
  },
  okx: {
    updatedAt: Date.UTC(2026, 2, 11, 10, 58, 0),
    termStructure: [
      { exp: '2026-03-20', label: 'Mar 20', dte: 9, atmIV: 52.7 },
    ],
    skewData: [],
    rawSurface: {
      expiries: [
        { exp: '2026-03-20', label: 'Mar 20', dte: 9 },
      ],
      buckets: [
        { key: -0.05, label: '-5%', moneynessPct: -4.9 },
        { key: 0, label: 'ATM', moneynessPct: 0 },
      ],
      cells: [
        { exp: '2026-03-20', bucketKey: -0.05, avgMarkIV: 55.8, count: 1, label: 'Mar 20', dte: 9, bucketLabel: '-5%', moneynessPct: -4.9, minStrike: 65000, maxStrike: 65000, optionTypes: ['put'] },
      ],
    },
  },
}

const termLevel = buildTermStructureChartData(datasets, ['deribit', 'okx'], 'level')
assert.equal(termLevel.length, 2)
assert.equal(termLevel[0].combined, 53.4)
assert.equal(termLevel[0].deribit, 53.2)
assert.equal(termLevel[1].okx, null, 'missing overlay expiries should remain null in level mode')

const termSpread = buildTermStructureChartData(datasets, ['deribit', 'okx'], 'spread')
assert.equal(termSpread[0].combined, 0)
assert.equal(termSpread[0].deribit, -0.2)
assert.equal(termSpread[0].okx, -0.7)

const skewSpread = buildSkewChartData(datasets, ['deribit'], 'rr', 'spread')
assert.equal(skewSpread[0].combined, 0)
assert.equal(skewSpread[0].deribit, -0.62)

const flyLevel = buildSkewChartData(datasets, ['deribit'], 'bf', 'level')
assert.equal(flyLevel[1].combined, 1.43)
assert.equal(flyLevel[1].deribit, 1.32)

const surface = buildSurfaceComparison(datasets.combined.rawSurface, datasets.deribit.rawSurface)
assert.equal(surface.cells.length, 2)
assert.equal(surface.cells[0].spread, -0.9)
assert.equal(surface.cells[1].spread, -0.5)

const freshness = getDatasetFreshness(datasets.deribit.updatedAt, Date.UTC(2026, 2, 11, 11, 0, 20))
assert.equal(freshness.status, 'fresh')
assert.equal(freshness.label, 'Current')

const aging = getDatasetFreshness(datasets.deribit.updatedAt, Date.UTC(2026, 2, 11, 11, 1, 5))
assert.equal(aging.status, 'aging')

const stale = getDatasetFreshness(datasets.okx.updatedAt, Date.UTC(2026, 2, 11, 11, 0, 5))
assert.equal(stale.status, 'stale')

const fullyStale = getDatasetFreshness(datasets.deribit.updatedAt, Date.UTC(2026, 2, 11, 11, 1, 25))
assert.equal(fullyStale.status, 'stale')

console.log('analysisComparison.test: ok')
