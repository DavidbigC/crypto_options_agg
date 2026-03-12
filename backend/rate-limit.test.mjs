import test from 'node:test'
import assert from 'node:assert/strict'

import { createRateLimiter } from './lib/rate-limit.js'

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

test('rate limiter allows requests under the limit', () => {
  let now = 1_000
  const limiter = createRateLimiter({
    limit: 2,
    windowMs: 10_000,
    now: () => now,
  })
  let nextCalls = 0
  const req = { method: 'GET', path: '/api/health', headers: {}, ip: '127.0.0.1' }

  limiter(req, createResponse(), () => { nextCalls += 1 })
  limiter(req, createResponse(), () => { nextCalls += 1 })

  assert.equal(nextCalls, 2)
})

test('rate limiter blocks repeated requests from the same client within the window', () => {
  let now = 1_000
  const limiter = createRateLimiter({
    limit: 1,
    windowMs: 10_000,
    now: () => now,
  })
  const req = { method: 'GET', path: '/api/stream/combined/BTC', headers: {}, ip: '127.0.0.1' }
  const firstRes = createResponse()
  const blockedRes = createResponse()
  let nextCalls = 0

  limiter(req, firstRes, () => { nextCalls += 1 })
  limiter(req, blockedRes, () => { nextCalls += 1 })

  assert.equal(nextCalls, 1)
  assert.equal(blockedRes.statusCode, 429)
  assert.match(blockedRes.body.error, /rate limit exceeded/i)
  assert.equal(blockedRes.headers['Retry-After'], '10')
})

test('rate limiter resets after the configured window', () => {
  let now = 1_000
  const limiter = createRateLimiter({
    limit: 1,
    windowMs: 1_000,
    now: () => now,
  })
  const req = { method: 'GET', path: '/api/arbs/BTC', headers: {}, ip: '127.0.0.1' }
  let nextCalls = 0

  limiter(req, createResponse(), () => { nextCalls += 1 })
  now = 2_100
  limiter(req, createResponse(), () => { nextCalls += 1 })

  assert.equal(nextCalls, 2)
})
