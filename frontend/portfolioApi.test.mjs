import test from 'node:test'
import assert from 'node:assert/strict'

const { requirePortfolioPayload } = await import('./lib/portfolioApi.js')

test('requirePortfolioPayload throws when backend returns an error payload', () => {
  assert.throws(
    () => requirePortfolioPayload({ error: 'Missing OKX credentials' }, 'OKX'),
    /Missing OKX credentials/,
  )
})

test('requirePortfolioPayload returns normal portfolio payloads unchanged', () => {
  const payload = { exchange: 'okx', positions: [] }
  assert.equal(requirePortfolioPayload(payload, 'OKX'), payload)
})
