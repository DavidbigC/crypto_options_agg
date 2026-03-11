import test from 'node:test'
import assert from 'node:assert/strict'

const { normalizeImportedPositionSize } = await import('./lib/positionSizing.js')

test('normalizeImportedPositionSize converts OKX option contracts into underlying-sized builder qty', () => {
  assert.deepEqual(
    normalizeImportedPositionSize({
      exchange: 'okx',
      coin: 'ETH',
      kind: 'option',
      size: -20,
    }),
    { qty: 2, contractSize: 1 },
  )
})
