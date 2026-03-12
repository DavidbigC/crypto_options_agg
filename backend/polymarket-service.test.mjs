import test from 'node:test'
import assert from 'node:assert/strict'

import { createPolymarketService } from './lib/polymarket/service.js'

test('createPolymarketService builds one asset and horizon payload from discovery and pricing data', async () => {
  const service = createPolymarketService({
    client: {
      getGammaMarkets: async () => ([
        {
          id: 'm1',
          question: 'Where will BTC close this week? $80k-$82k',
          volumeNum: 120000,
          clobTokenIds: ['101'],
        },
        {
          id: 'm2',
          question: 'Where will BTC close this week? $82k-$84k',
          volumeNum: 150000,
          clobTokenIds: ['102'],
        },
      ]),
      getClobPrices: async () => ({
        '101': 0.4,
        '102': 0.6,
      }),
      getOpenInterest: async (marketId) => ([
        { market: marketId, open_interest: marketId === 'm1' ? 50000 : 80000 },
      ]),
    },
  })

  const result = await service.getAnalysis({ asset: 'BTC', horizon: 'weekly', spotPrice: 83000 })

  assert.equal(result.asset, 'BTC')
  assert.equal(result.horizon, 'weekly')
  assert.equal(result.distribution.source, 'range')
  assert.equal(result.summary.expectedPrice, 82200)
  assert.equal(result.summary.expectedMove, 800)
  assert.equal(result.summary.mostLikelyRange.low, 82000)
  assert.equal(result.sourceMarkets.length, 2)
})

test('createPolymarketService excludes weak markets from the derived signal', async () => {
  const service = createPolymarketService({
    minVolume: 1000,
    minOpenInterest: 1000,
    maxSpreadPct: 0.1,
    client: {
      getGammaMarkets: async () => ([
        {
          id: 'strong',
          question: 'Where will ETH close this month? $2,800-$3,000',
          volumeNum: 5000,
          clobTokenIds: ['201'],
        },
        {
          id: 'weak',
          question: 'Where will ETH close this month? $3,000-$3,200',
          volumeNum: 50,
          clobTokenIds: ['202'],
        },
      ]),
      getClobPrices: async () => ({
        '201': 0.75,
        '202': 0.25,
      }),
      getOpenInterest: async (marketId) => ([
        { market: marketId, open_interest: marketId === 'strong' ? 5000 : 10 },
      ]),
    },
  })

  const result = await service.getAnalysis({ asset: 'ETH', horizon: 'monthly', spotPrice: 2900 })

  assert.equal(result.sourceMarkets.length, 2)
  assert.equal(result.eligibleMarkets.length, 1)
  assert.equal(result.eligibleMarkets[0].id, 'strong')
  assert.equal(result.distribution.bins.length, 1)
})

test('createPolymarketService returns a confidence score and repricing summary', async () => {
  const service = createPolymarketService({
    client: {
      getGammaMarkets: async () => ([
        {
          id: 'm1',
          question: 'Will SOL be above $200 this month?',
          volumeNum: 9000,
          clobTokenIds: ['301'],
        },
        {
          id: 'm2',
          question: 'Will SOL be above $220 this month?',
          volumeNum: 7000,
          clobTokenIds: ['302'],
        },
      ]),
      getClobPrices: async () => ({
        '301': 0.6,
        '302': 0.3,
      }),
      getOpenInterest: async (marketId) => ([
        { market: marketId, open_interest: marketId === 'm1' ? 4000 : 3000 },
      ]),
    },
  })

  const result = await service.getAnalysis({ asset: 'SOL', horizon: 'monthly', spotPrice: 210 })

  assert.equal(typeof result.confidence.score, 'number')
  assert.match(result.confidence.label, /low|medium|high/)
  assert.equal(result.repricing.change24h, null)
  assert.equal(result.repricing.change7d, null)
})
