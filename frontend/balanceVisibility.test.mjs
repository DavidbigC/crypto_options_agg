import test from 'node:test'
import assert from 'node:assert/strict'

const { filterVisibleBalances } = await import('./lib/portfolioBalances.js')

test('filterVisibleBalances keeps only BTC ETH USDT balances with at least one dollar of value', () => {
  const balances = [
    { currency: 'ETH', usdValue: 5715.77 },
    { currency: 'USDT', usdValue: 12.5 },
    { currency: 'BTC', usdValue: 0.99 },
    { currency: 'RON', usdValue: 50 },
    { currency: 'ACE', usdValue: 0.2 },
  ]

  assert.deepEqual(filterVisibleBalances(balances), [
    { currency: 'ETH', usdValue: 5715.77 },
    { currency: 'USDT', usdValue: 12.5 },
  ])
})
