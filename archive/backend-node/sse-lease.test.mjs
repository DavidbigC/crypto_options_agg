import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { attachSseLease } from './lib/sse-lease.js'

function makeReq() {
  const req = new EventEmitter()
  req.on = req.addListener.bind(req)
  return req
}

function makeRes() {
  return {
    ended: false,
    endCalls: 0,
    end() {
      this.ended = true
      this.endCalls += 1
    },
  }
}

test('attachSseLease ends the response when the lease expires', async () => {
  const req = makeReq()
  const res = makeRes()
  let cleanupCalls = 0

  attachSseLease({
    req,
    res,
    leaseMs: 20,
    onCleanup() {
      cleanupCalls += 1
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 35))

  assert.equal(res.ended, true)
  assert.equal(res.endCalls, 1)
  assert.equal(cleanupCalls, 1)
})

test('attachSseLease cleans up when the request closes before expiry', async () => {
  const req = makeReq()
  const res = makeRes()
  let cleanupCalls = 0

  attachSseLease({
    req,
    res,
    leaseMs: 50,
    onCleanup() {
      cleanupCalls += 1
    },
  })

  req.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 70))

  assert.equal(res.ended, false)
  assert.equal(res.endCalls, 0)
  assert.equal(cleanupCalls, 1)
})

test('attachSseLease only runs cleanup once across timeout and close paths', async () => {
  const req = makeReq()
  const res = makeRes()
  let cleanupCalls = 0

  attachSseLease({
    req,
    res,
    leaseMs: 20,
    onCleanup() {
      cleanupCalls += 1
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 35))
  req.emit('close')

  assert.equal(res.endCalls, 1)
  assert.equal(cleanupCalls, 1)
})
