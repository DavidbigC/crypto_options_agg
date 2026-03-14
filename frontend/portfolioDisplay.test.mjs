import test from 'node:test'
import assert from 'node:assert/strict'

const { getPortfolioDisplayData } = await import('./lib/portfolioDisplay.js')

test('getPortfolioDisplayData provides safe defaults for partial portfolio payloads', () => {
  const data = getPortfolioDisplayData({ balances: [] }, 'OKX')

  assert.equal(data.exchangeName, 'OKX')
  assert.equal(data.accountLabel, 'OKX')
  assert.equal(data.permission, 'unknown')
  assert.equal(data.settleCurrency, 'N/A')
  assert.equal(data.totalEquityUsd, 0)
  assert.equal(data.availableEquityUsd, null)
  assert.equal(data.derivativesCount, 0)
  assert.equal(data.openPositions, 0)
  assert.deepEqual(data.totalGreeks, { delta: 0, gamma: 0, theta: 0, vega: 0 })
  assert.deepEqual(data.greeksByCoin, {})
  assert.deepEqual(data.positions, [])
})
