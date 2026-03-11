import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  createBybitPortfolioService,
  normalizeBybitPortfolio,
} from './lib/bybit-portfolio.js'

test('normalizeBybitPortfolio returns balances, parsed derivatives positions, and Greek aggregates', () => {
  const result = normalizeBybitPortfolio({
    accountPayload: {
      result: {
        marginMode: 'PORTFOLIO_MARGIN',
        unifiedMarginStatus: 4,
      },
    },
    balancePayload: {
      result: {
        list: [{
          accountType: 'UNIFIED',
          totalEquity: '3250.5',
          totalAvailableBalance: '1800.2',
          coin: [
            {
              coin: 'BTC',
              equity: '0.1',
              usdValue: '8400',
              walletBalance: '0.08',
              locked: '0.01',
              unrealisedPnl: '50',
            },
            {
              coin: 'USDC',
              equity: '1200',
              usdValue: '1200',
              walletBalance: '900',
              locked: '50',
              unrealisedPnl: '-10',
            },
          ],
        }],
      },
    },
    positionPayloads: [{
      result: {
        category: 'option',
        list: [
          {
            symbol: 'BTC-27MAR26-90000-C',
            side: 'Sell',
            size: '2',
            avgPrice: '0.015',
            markPrice: '0.02',
            unrealisedPnl: '-0.3',
            positionIM: '0.5',
            delta: '-0.15',
            gamma: '0.002',
            theta: '-0.04',
            vega: '0.6',
            tradeMode: 0,
          },
        ],
      },
    }, {
      result: {
        category: 'linear',
        list: [
          {
            symbol: 'ETHUSDT',
            side: 'Buy',
            size: '3',
            avgPrice: '2100',
            markPrice: '2200',
            unrealisedPnl: '150',
            positionIM: '200',
            delta: '3',
            gamma: '0',
            theta: '0',
            vega: '0',
            tradeMode: 0,
          },
        ],
      },
    }],
    now: '2026-03-11T12:00:00.000Z',
  })

  assert.equal(result.exchange, 'bybit')
  assert.equal(result.summary.totalEquityUsd, 3250.5)
  assert.equal(result.summary.availableEquityUsd, 1800.2)
  assert.equal(result.summary.openPositions, 2)
  assert.equal(result.summary.derivativesCount, 2)
  assert.equal(result.summary.balancesCount, 2)
  assert.equal(result.summary.updatedAt, '2026-03-11T12:00:00.000Z')
  assert.deepEqual(result.account, {
    label: 'Bybit Unified',
    permission: 'read_only',
    positionMode: 'merged_single',
    greeksType: 'BS',
    settleCurrency: 'USD',
  })
  assert.deepEqual(result.balances, [{
    currency: 'BTC',
    equity: 0.1,
    usdValue: 8400,
    available: 0.08,
    frozen: 0.01,
    upl: 50,
  }, {
    currency: 'USDC',
    equity: 1200,
    usdValue: 1200,
    available: 900,
    frozen: 50,
    upl: -10,
  }])
  assert.deepEqual(result.greeks.total, {
    delta: 2.85,
    gamma: 0.002,
    theta: -0.04,
    vega: 0.6,
  })
  assert.deepEqual(result.greeks.byCoin, {
    BTC: { delta: -0.15, gamma: 0.002, theta: -0.04, vega: 0.6 },
    ETH: { delta: 3, gamma: 0, theta: 0, vega: 0 },
  })
  assert.deepEqual(result.positions, [{
    instrument: 'ETHUSDT',
    instrumentType: 'LINEAR',
    coin: 'ETH',
    kind: 'future',
    optionType: null,
    expiry: 'perpetual',
    strike: null,
    referencePrice: 2200,
    marginMode: 'cross',
    size: 3,
    averagePrice: 2100,
    markPrice: 2200,
    unrealizedPnl: 150,
    unrealizedPnlRatio: 0.75,
    delta: 3,
    gamma: 0,
    theta: 0,
    vega: 0,
    notionalUsd: 6600,
  }, {
    instrument: 'BTC-27MAR26-90000-C',
    instrumentType: 'OPTION',
    coin: 'BTC',
    kind: 'option',
    optionType: 'call',
    expiry: '2026-03-27',
    strike: 90000,
    referencePrice: 0,
    marginMode: 'cross',
    size: -2,
    averagePrice: 0.015,
    markPrice: 0.02,
    unrealizedPnl: -0.3,
    unrealizedPnlRatio: -0.6,
    delta: -0.15,
    gamma: 0.002,
    theta: -0.04,
    vega: 0.6,
    notionalUsd: 0,
  }])
})

test('createBybitPortfolioService throws when credentials are missing', async () => {
  const service = createBybitPortfolioService({
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch')
    },
  })

  await assert.rejects(
    () => service.fetchPortfolio(),
    /missing bybit credentials/i,
  )
})

test('fetchPortfolio signs requests and combines Bybit account endpoints', async () => {
  const seen = []
  const timestamp = '1710000000000'
  const recvWindow = '5000'
  const env = {
    BYBIT_API_KEY: 'bybit-key',
    BYBIT_API_SECRET: 'bybit-secret',
  }
  const service = createBybitPortfolioService({
    env,
    now: () => '2026-03-11T00:00:00.000Z',
    timestamp: () => timestamp,
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers })
      return {
        ok: true,
        status: 200,
        json: async () => {
          if (url.includes('/v5/account/info')) {
            return {
              retCode: 0,
              retMsg: 'OK',
              result: {
                marginMode: 'REGULAR_MARGIN',
              },
            }
          }
          if (url.includes('/v5/account/wallet-balance')) {
            return {
              retCode: 0,
              retMsg: 'OK',
              result: {
                list: [{
                  accountType: 'UNIFIED',
                  totalEquity: '0',
                  totalAvailableBalance: '0',
                  coin: [],
                }],
              },
            }
          }
          return {
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [],
            },
          }
        },
      }
    },
  })

  const result = await service.fetchPortfolio()

  assert.equal(seen.length, 6)
  assert.match(seen[0].url, /https:\/\/api\.bybit\.com\/v5\//)
  assert.equal(seen[0].headers['X-BAPI-API-KEY'], 'bybit-key')
  assert.equal(seen[0].headers['X-BAPI-TIMESTAMP'], timestamp)
  assert.equal(seen[0].headers['X-BAPI-RECV-WINDOW'], recvWindow)
  assert.equal(
    seen[0].headers['X-BAPI-SIGN'],
    crypto.createHmac('sha256', env.BYBIT_API_SECRET)
      .update(`${timestamp}${env.BYBIT_API_KEY}${recvWindow}`)
      .digest('hex'),
  )
  assert.ok(
    seen.some(({ url }) => url.includes('/v5/position/list?category=option')),
  )
  assert.ok(
    seen.some(({ url }) => url.includes('/v5/position/list?category=linear&settleCoin=USDT')),
  )
  assert.ok(
    seen.some(({ url }) => url.includes('/v5/position/list?category=linear&settleCoin=USDC')),
  )
  assert.ok(
    seen.some(({ url }) => url.includes('/v5/position/list?category=inverse')),
  )
  assert.equal(result.exchange, 'bybit')
  assert.equal(result.summary.openPositions, 0)
})
