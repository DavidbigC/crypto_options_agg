import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCombinedResponse } from './lib/combined.js'

test('buildCombinedResponse includes derive quotes in combined best pricing', () => {
  const response = buildCombinedResponse('BTC', {
    bybitApi: {
      parseOptionSymbol(symbol) {
        if (symbol !== 'BTC-20260327-80000-C') return null
        return { expiryDate: '2026-03-27', strikePrice: 80000, optionType: 'CALL' }
      },
    },
    bybitTickerCache: {
      BTC: {
        'BTC-20260327-80000-C': {
          symbol: 'BTC-20260327-80000-C',
          bid1Price: '1200',
          ask1Price: '1500',
          delta: '0.31',
          gamma: '0.0012',
          theta: '-12',
          vega: '40',
          impliedVolatility: '0.48',
          bid1Iv: '0.47',
          ask1Iv: '0.49',
          underlyingPrice: '81000',
        },
      },
    },
    bybitSpotCache: { BTC: 81000 },
    okxCache: {},
    okxTickerCache: {},
    okxSpotCache: {},
    parseOkxInstId() {
      return null
    },
    buildDeribitResponse() {
      return null
    },
    buildDeriveResponse() {
      return {
        spotPrice: 80950,
        expirations: ['2026-03-27'],
        expirationCounts: { '2026-03-27': { calls: 1, puts: 0 } },
        data: {
          '2026-03-27': {
            calls: [{
              strike: 80000,
              optionType: 'call',
              bid: 1300,
              ask: 1400,
              delta: 0.42,
              gamma: 0.0018,
              theta: -10,
              vega: 55,
              markVol: 0.55,
              bidVol: 0.54,
              askVol: 0.56,
            }],
            puts: [],
          },
        },
      }
    },
    binanceCache: {},
    binanceSpotCache: {},
    parseBinanceSymbol() {
      return null
    },
  })

  const contract = response.data['2026-03-27'].calls[0]

  assert.equal(contract.prices.derive.bid, 1300)
  assert.equal(contract.prices.derive.ask, 1400)
  assert.equal(contract.bestBid, 1300)
  assert.equal(contract.bestBidEx, 'derive')
  assert.equal(contract.bestAsk, 1400)
  assert.equal(contract.bestAskEx, 'derive')
  assert.equal(contract.delta, 0.42)
  assert.equal(contract.markVol, 0.55)
})
