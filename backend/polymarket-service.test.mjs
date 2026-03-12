import test from 'node:test'
import assert from 'node:assert/strict'

import { createPolymarketService } from './lib/polymarket/service.js'

test('createPolymarketService builds one asset and horizon payload from discovery and pricing data', async () => {
  const service = createPolymarketService({
    client: {
      searchGamma: async () => ({
        events: [{
          slug: 'btc-weekly',
          title: 'Bitcoin weekly',
          tags: [{ slug: 'bitcoin' }, { slug: 'weekly' }],
          markets: [
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
          ],
        }],
      }),
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
      searchGamma: async () => ({
        events: [{
          slug: 'eth-monthly',
          title: 'Ethereum monthly',
          tags: [{ slug: 'ethereum' }, { slug: 'monthly' }],
          markets: [
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
          ],
        }],
      }),
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
      searchGamma: async () => ({
        events: [{
          slug: 'sol-monthly',
          title: 'Solana monthly',
          tags: [{ slug: 'solana' }, { slug: 'monthly' }],
          markets: [
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
          ],
        }],
      }),
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

test('createPolymarketService discovers markets from Gamma search event metadata and parses string clobTokenIds', async () => {
  const service = createPolymarketService({
    client: {
      searchGamma: async () => ({
        events: [{
          slug: 'bitcoin-above-on-march-12',
          tags: [
            { slug: 'bitcoin', label: 'Bitcoin' },
            { slug: 'weekly', label: 'Weekly' },
          ],
          markets: [
            {
              id: 'm1',
              slug: 'bitcoin-above-80k-on-march-12',
              question: 'Will the price of Bitcoin be above $80,000 on March 12?',
              volumeNum: 150000,
              spread: 0.01,
              clobTokenIds: '[\"401\",\"402\"]',
            },
            {
              id: 'm2',
              slug: 'bitcoin-above-82k-on-march-12',
              question: 'Will the price of Bitcoin be above $82,000 on March 12?',
              volumeNum: 125000,
              spread: 0.01,
              clobTokenIds: '[\"403\",\"404\"]',
            },
          ],
        }],
      }),
      getGammaMarkets: async () => {
        throw new Error('generic markets discovery should not be used')
      },
      getClobPrices: async () => ({
        '401': 0.9,
        '403': 0.55,
      }),
      getOpenInterest: async (marketId) => ([
        { market: marketId, open_interest: marketId === 'm1' ? 10000 : 12000 },
      ]),
    },
  })

  const result = await service.getAnalysis({ asset: 'BTC', horizon: 'weekly', spotPrice: 81000 })

  assert.equal(result.sourceMarkets.length, 2)
  assert.equal(result.eligibleMarkets.length, 2)
  assert.equal(result.distribution.source, 'threshold')
  assert.equal(result.eligibleMarkets[0].tokenId, '401')
})

test('createPolymarketService uses Gamma lastTradePrice directly when available', async () => {
  const service = createPolymarketService({
    client: {
      searchGamma: async () => ({
        events: [{
          slug: 'btc-weekly',
          title: 'Bitcoin weekly',
          tags: [{ slug: 'bitcoin' }, { slug: 'weekly' }],
          markets: [
            {
              id: 'm1',
              slug: 'bitcoin-above-80k-on-march-12',
              question: 'Will the price of Bitcoin be above $80,000 on March 12?',
              volumeNum: 150000,
              spread: 0.01,
              lastTradePrice: 0.9,
              clobTokenIds: '[\"401\",\"402\"]',
            },
            {
              id: 'm2',
              slug: 'bitcoin-above-82k-on-march-12',
              question: 'Will the price of Bitcoin be above $82,000 on March 12?',
              volumeNum: 125000,
              spread: 0.01,
              lastTradePrice: 0.55,
              clobTokenIds: '[\"403\",\"404\"]',
            },
          ],
        }],
      }),
      getClobPrices: async () => {
        throw new Error('should not call clob when gamma already provides lastTradePrice')
      },
      getOpenInterest: async () => ([{ open_interest: 10000 }]),
    },
  })

  const result = await service.getAnalysis({ asset: 'BTC', horizon: 'weekly', spotPrice: 81000 })

  assert.equal(result.sourceMarkets.length, 2)
  assert.equal(result.sourceMarkets[0].lastTradePrice, 0.9)
  assert.equal(result.distribution.source, 'threshold')
})

test('createPolymarketService requests open interest with conditionId and reads value payloads', async () => {
  const seen = []
  const service = createPolymarketService({
    client: {
      searchGamma: async () => ({
        events: [{
          slug: 'btc-weekly',
          title: 'Bitcoin weekly',
          tags: [{ slug: 'bitcoin' }, { slug: 'weekly' }],
          markets: [
            {
              id: 'm1',
              conditionId: '0xabc',
              question: 'Will the price of Bitcoin be above $80,000 on March 12?',
              volumeNum: 150000,
              spread: 0.01,
              lastTradePrice: 0.9,
              clobTokenIds: '[\"401\",\"402\"]',
            },
          ],
        }],
      }),
      getClobPrices: async () => ({}),
      getOpenInterest: async (marketKey) => {
        seen.push(marketKey)
        return [{ market: marketKey, value: 12345 }]
      },
    },
  })

  const result = await service.getAnalysis({ asset: 'BTC', horizon: 'weekly', spotPrice: 81000 })

  assert.deepEqual(seen, ['0xabc'])
  assert.equal(result.sourceMarkets[0].openInterest, 12345)
  assert.equal(result.eligibleMarkets.length, 1)
})

test('createPolymarketService keeps only active non-closed markets from the nearest relevant event set', async () => {
  const service = createPolymarketService({
    client: {
      searchGamma: async () => ({
        events: [
          {
            slug: 'btc-weekly-old',
            title: 'Bitcoin weekly old',
            active: false,
            closed: true,
            endDate: '2026-03-05T16:00:00Z',
            tags: [{ slug: 'bitcoin' }, { slug: 'weekly' }],
            markets: [
              {
                id: 'old-1',
                conditionId: '0xold1',
                question: 'Will the price of Bitcoin be above $80,000 on March 5?',
                volumeNum: 150000,
                spread: 0.01,
                lastTradePrice: 0.9,
                active: false,
                closed: true,
                clobTokenIds: '[\"501\",\"502\"]',
              },
            ],
          },
          {
            slug: 'btc-weekly-current',
            title: 'Bitcoin weekly current',
            active: true,
            closed: false,
            endDate: '2026-03-12T16:00:00Z',
            tags: [{ slug: 'bitcoin' }, { slug: 'weekly' }],
            markets: [
              {
                id: 'cur-1',
                conditionId: '0xcur1',
                question: 'Will the price of Bitcoin be above $80,000 on March 12?',
                volumeNum: 150000,
                spread: 0.01,
                lastTradePrice: 0.9,
                active: true,
                closed: false,
                clobTokenIds: '[\"601\",\"602\"]',
              },
              {
                id: 'cur-2',
                conditionId: '0xcur2',
                question: 'Will the price of Bitcoin be above $82,000 on March 12?',
                volumeNum: 125000,
                spread: 0.01,
                lastTradePrice: 0.55,
                active: true,
                closed: false,
                clobTokenIds: '[\"603\",\"604\"]',
              },
            ],
          },
        ],
      }),
      getClobPrices: async () => ({}),
      getOpenInterest: async () => ([{ value: 10000 }]),
    },
  })

  const result = await service.getAnalysis({ asset: 'BTC', horizon: 'weekly', spotPrice: 81000 })

  assert.equal(result.sourceMarkets.length, 2)
  assert.equal(result.eligibleMarkets.length, 2)
  assert.deepEqual(result.sourceMarkets.map((market) => market.id), ['cur-1', 'cur-2'])
})
