import test from 'node:test'
import assert from 'node:assert/strict'

import { isValidStreamCoin } from './lib/stream-params.js'

test('isValidStreamCoin accepts plain spot coins for non-OKX exchanges', () => {
  assert.equal(isValidStreamCoin('bybit', 'BTC'), true)
  assert.equal(isValidStreamCoin('combined', 'ETH'), true)
  assert.equal(isValidStreamCoin('binance', 'SOL'), true)
})

test('isValidStreamCoin accepts OKX option family symbols for OKX streams', () => {
  assert.equal(isValidStreamCoin('okx', 'BTC-USD'), true)
  assert.equal(isValidStreamCoin('okx', 'ETH-USD'), true)
  assert.equal(isValidStreamCoin('okx', 'SOL-USD'), true)
})

test('isValidStreamCoin rejects family symbols for non-OKX streams', () => {
  assert.equal(isValidStreamCoin('bybit', 'BTC-USD'), false)
  assert.equal(isValidStreamCoin('combined', 'ETH-USD'), false)
})

test('isValidStreamCoin rejects unsupported coins', () => {
  assert.equal(isValidStreamCoin('okx', 'DOGE-USD'), false)
  assert.equal(isValidStreamCoin('bybit', 'DOGE'), false)
})
