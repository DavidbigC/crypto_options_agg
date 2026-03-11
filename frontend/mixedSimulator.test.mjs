import test from 'node:test'
import assert from 'node:assert/strict'

const {
  clearImportedExchangeLegs,
  mergeImportedExchangeLegs,
} = await import('./lib/mixedSimulator.js')

test('mergeImportedExchangeLegs appends bybit, replaces same-exchange imports, and preserves manual legs', () => {
  const existing = [
    { id: 'manual-okx', exchange: 'okx', coin: 'ETH', source: 'manual' },
    { id: 'import-okx-old', exchange: 'okx', coin: 'ETH', source: 'portfolio-import' },
  ]

  const withBybit = mergeImportedExchangeLegs(existing, [
    { id: 'import-bybit-1', exchange: 'bybit', coin: 'ETH', source: 'portfolio-import' },
  ], 'bybit')

  assert.deepEqual(withBybit.map((leg) => leg.id), [
    'manual-okx',
    'import-okx-old',
    'import-bybit-1',
  ])

  const withOkxReloaded = mergeImportedExchangeLegs(withBybit, [
    { id: 'import-okx-new-1', exchange: 'okx', coin: 'ETH', source: 'portfolio-import' },
    { id: 'import-okx-new-2', exchange: 'okx', coin: 'BTC', source: 'portfolio-import' },
  ], 'okx')

  assert.deepEqual(withOkxReloaded.map((leg) => leg.id), [
    'manual-okx',
    'import-bybit-1',
    'import-okx-new-1',
    'import-okx-new-2',
  ])
})

test('clearImportedExchangeLegs removes only imported legs for one exchange', () => {
  const existing = [
    { id: 'manual-okx', exchange: 'okx', coin: 'ETH', source: 'manual' },
    { id: 'import-okx', exchange: 'okx', coin: 'ETH', source: 'portfolio-import' },
    { id: 'import-bybit', exchange: 'bybit', coin: 'ETH', source: 'portfolio-import' },
  ]

  assert.deepEqual(
    clearImportedExchangeLegs(existing, 'okx').map((leg) => leg.id),
    ['manual-okx', 'import-bybit'],
  )
})
