import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createOkxPortfolioService,
  normalizeOkxPortfolio,
} from './lib/okx-portfolio.js'

test('normalizeOkxPortfolio returns balances, parsed derivatives positions, and Greek aggregates', () => {
  const result = normalizeOkxPortfolio({
    configPayload: {
      data: [{
        label: 'options',
        perm: 'read_only',
        posMode: 'net_mode',
        greeksType: 'BS',
        settleCcy: 'USDC',
      }],
    },
    balancePayload: {
      data: [{
        totalEq: '1000',
        details: [{
          ccy: 'ETH',
          eq: '2',
          eqUsd: '500',
          availBal: '1.5',
          frozenBal: '0.5',
          upl: '0.1',
        }],
      }],
    },
    positionsPayload: {
      data: [
        {
          instId: 'ETH-USD-260320-2500-C',
          instType: 'OPTION',
          pos: '-2',
          avgPx: '0.01',
          markPx: '0.02',
          upl: '0.5',
          uplRatio: '0.25',
          deltaBS: '0.1',
          gammaBS: '0.2',
          thetaBS: '-0.3',
          vegaBS: '0.4',
          mgnMode: 'cross',
          notionalUsd: '4000',
          idxPx: '2050',
        },
        {
          instId: 'BTC-USD-SWAP',
          instType: 'SWAP',
          pos: '3',
          avgPx: '82000',
          markPx: '82500',
          upl: '50',
          uplRatio: '0.05',
          deltaBS: '3',
          gammaBS: '0',
          thetaBS: '0',
          vegaBS: '0',
          mgnMode: 'cross',
          notionalUsd: '247500',
          idxPx: '82500',
        },
        {
          instId: 'ETH-USD-260320-2500-C',
          instType: 'OPTION',
          pos: '0',
        },
      ],
    },
    now: '2026-03-10T12:00:00.000Z',
  })

  assert.equal(result.exchange, 'okx')
  assert.equal(result.summary.openPositions, 2)
  assert.equal(result.summary.derivativesCount, 2)
  assert.equal(result.summary.totalEquityUsd, 1000)
  assert.equal(result.summary.updatedAt, '2026-03-10T12:00:00.000Z')
  assert.equal(result.account.permission, 'read_only')
  assert.deepEqual(result.balances, [{
    currency: 'ETH',
    equity: 2,
    usdValue: 500,
    available: 1.5,
    frozen: 0.5,
    upl: 0.1,
  }])
  assert.deepEqual(result.greeks.total, {
    delta: 3.1,
    gamma: 0.2,
    theta: -0.3,
    vega: 0.4,
  })
  assert.deepEqual(result.greeks.byCoin, {
    BTC: { delta: 3, gamma: 0, theta: 0, vega: 0 },
    ETH: { delta: 0.1, gamma: 0.2, theta: -0.3, vega: 0.4 },
  })
  assert.deepEqual(result.positions, [{
    instrument: 'BTC-USD-SWAP',
    instrumentType: 'SWAP',
    coin: 'BTC',
    kind: 'swap',
    optionType: null,
    expiry: 'perpetual',
    strike: null,
    referencePrice: 82500,
    marginMode: 'cross',
    size: 3,
    averagePrice: 82000,
    markPrice: 82500,
    unrealizedPnl: 50,
    unrealizedPnlRatio: 0.05,
    delta: 3,
    gamma: 0,
    theta: 0,
    vega: 0,
    notionalUsd: 247500,
  }, {
    instrument: 'ETH-USD-260320-2500-C',
    instrumentType: 'OPTION',
    coin: 'ETH',
    kind: 'option',
    optionType: 'call',
    expiry: '2026-03-20',
    strike: 2500,
    referencePrice: 2050,
    marginMode: 'cross',
    size: -2,
    averagePrice: 0.01,
    markPrice: 0.02,
    unrealizedPnl: 0.5,
    unrealizedPnlRatio: 0.25,
    delta: 0.1,
    gamma: 0.2,
    theta: -0.3,
    vega: 0.4,
    notionalUsd: 4000,
  }])
})

test('createOkxPortfolioService throws when credentials are missing', async () => {
  const service = createOkxPortfolioService({
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch')
    },
  })

  await assert.rejects(
    () => service.fetchPortfolio(),
    /missing okx credentials/i,
  )
})

test('fetchPortfolio signs requests and combines the three OKX account endpoints', async () => {
  const seen = []
  const service = createOkxPortfolioService({
    env: {
      OKX_API_KEY: 'key',
      OKX_SECRET_KEY: 'secret',
      OKX_PASSPHRASE: 'passphrase',
    },
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: '0',
          data: [],
        }),
      }
    },
  })

  const result = await service.fetchPortfolio()

  assert.equal(seen.length, 3)
  assert.match(seen[0].url, /https:\/\/www\.okx\.com\/api\/v5\/account\//)
  assert.equal(seen[0].headers['OK-ACCESS-KEY'], 'key')
  assert.ok(seen[0].headers['OK-ACCESS-SIGN'])
  assert.equal(result.summary.openPositions, 0)
  assert.equal(typeof result.summary.updatedAt, 'string')
})
