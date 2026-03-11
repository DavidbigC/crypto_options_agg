import test from 'node:test'
import assert from 'node:assert/strict'

const { CONTRACT_SIZES } = await import('./types/options.ts')

test('OKX option contract sizes match current exchange multipliers', () => {
  assert.equal(CONTRACT_SIZES.okx.BTC, 0.01)
  assert.equal(CONTRACT_SIZES.okx.ETH, 0.1)
})
