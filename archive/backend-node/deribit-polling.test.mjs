import test from 'node:test'
import assert from 'node:assert/strict'

import { deribitCache, pollDeribitOptions, pollDeribitSpot } from './lib/deribit.js'

test('pollDeribitOptions keeps cache and logs empty upstream response clearly', async () => {
  const originalFetch = global.fetch
  const originalError = console.error
  const errors = []

  deribitCache.BTC.summaries = [{ instrument_name: 'BTC-27MAR26-80000-C' }]

  global.fetch = async () => new Response('', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  console.error = (...args) => { errors.push(args.join(' ')) }

  try {
    await pollDeribitOptions('BTC')
  } finally {
    global.fetch = originalFetch
    console.error = originalError
  }

  assert.deepEqual(deribitCache.BTC.summaries, [{ instrument_name: 'BTC-27MAR26-80000-C' }])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /empty response/i)
  assert.doesNotMatch(errors[0], /Unexpected end of JSON input/)
})

test('pollDeribitSpot keeps last price and logs empty upstream response clearly', async () => {
  const originalFetch = global.fetch
  const originalError = console.error
  const errors = []

  deribitCache.BTC.spot = 82500

  global.fetch = async () => new Response('', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  console.error = (...args) => { errors.push(args.join(' ')) }

  try {
    await pollDeribitSpot('BTC')
  } finally {
    global.fetch = originalFetch
    console.error = originalError
  }

  assert.equal(deribitCache.BTC.spot, 82500)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /empty response/i)
  assert.doesNotMatch(errors[0], /Unexpected end of JSON input/)
})
