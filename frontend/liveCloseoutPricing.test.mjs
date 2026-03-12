import test from 'node:test'
import assert from 'node:assert/strict'

const { resolveCloseoutPrice } = await import('./lib/liveCloseoutPricing.js')

test('resolveCloseoutPrice uses bid to close longs and ask to close shorts', () => {
  const contract = { bid: 8, ask: 10, markPrice: 9 }

  assert.equal(
    resolveCloseoutPrice({ leg: { side: 'buy', type: 'call' }, contract, fallbackPrice: 0 }),
    8,
  )

  assert.equal(
    resolveCloseoutPrice({ leg: { side: 'sell', type: 'put' }, contract, fallbackPrice: 0 }),
    10,
  )
})

test('resolveCloseoutPrice falls back to markPrice and then fallbackPrice', () => {
  assert.equal(
    resolveCloseoutPrice({
      leg: { side: 'buy', type: 'call' },
      contract: { bid: 0, ask: 0, markPrice: 7 },
      fallbackPrice: 5,
    }),
    7,
  )

  assert.equal(
    resolveCloseoutPrice({
      leg: { side: 'buy', type: 'call' },
      contract: null,
      fallbackPrice: 5,
    }),
    5,
  )
})

test('resolveCloseoutPrice uses exchange-specific combined quotes before falling back', () => {
  const combinedContract = {
    bestBid: 7850,
    bestAsk: 7285,
    prices: {
      bybit: { bid: 7850, ask: 7390 },
      okx: { bid: 7800, ask: 7350 },
      deribit: { bid: 0, ask: 0 },
      derive: { bid: 7825, ask: 7340 },
    },
  }

  assert.equal(
    resolveCloseoutPrice({
      leg: { side: 'buy', type: 'put', exchange: 'bybit' },
      contract: combinedContract,
      fallbackPrice: 7600,
    }),
    7850,
  )

  assert.equal(
    resolveCloseoutPrice({
      leg: { side: 'sell', type: 'call', exchange: 'bybit' },
      contract: combinedContract,
      fallbackPrice: 7760,
    }),
    7390,
  )

  assert.equal(
    resolveCloseoutPrice({
      leg: { side: 'sell', type: 'call', exchange: 'derive' },
      contract: combinedContract,
      fallbackPrice: 7760,
    }),
    7340,
  )
})
