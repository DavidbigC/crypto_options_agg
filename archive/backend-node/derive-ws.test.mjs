import test from 'node:test'
import assert from 'node:assert/strict'

import {
  removeDeriveViewer,
  startDeriveFeed,
  __resetDeriveStateForTests,
  __setDeriveWebSocketFactoryForTests,
} from './lib/derive-ws.js'

const originalFetch = global.fetch
const originalSetInterval = global.setInterval
const originalClearInterval = global.clearInterval

test.beforeEach(() => {
  __resetDeriveStateForTests()
  global.setInterval = () => ({ mocked: true })
  global.clearInterval = () => {}
})

test.afterEach(() => {
  global.fetch = originalFetch
  global.setInterval = originalSetInterval
  global.clearInterval = originalClearInterval
})

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('startDeriveFeed connects without viewers', () => {
  const sockets = []

  __setDeriveWebSocketFactoryForTests((url) => {
    sockets.push({ url })
    return {
      on() {},
      terminate() {},
      readyState: 0,
    }
  })

  startDeriveFeed()

  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].url, 'wss://api.lyra.finance/ws')
})

test('startDeriveFeed subscribes all supported currencies on open', async () => {
  const sockets = []
  const sent = []

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.currency) {
      return {
        async json() {
          return {
            result: {
              instruments: [
                { instrument_name: `${body.currency}-20260327-80000-C` },
              ],
            },
          }
        },
      }
    }

    return {
      async json() {
        return { result: { index_price: 80000, tickers: {} } }
      },
    }
  }

  __setDeriveWebSocketFactoryForTests((url) => {
    const handlers = {}
    const socket = {
      url,
      readyState: 0,
      on(event, handler) {
        handlers[event] = handler
      },
      send(payload) {
        sent.push(JSON.parse(payload))
      },
      emit(event, ...args) {
        if (event === 'open') socket.readyState = 1
        if (event === 'close') socket.readyState = 3
        handlers[event]?.(...args)
      },
      terminate() {
        socket.emit('close')
      },
    }
    sockets.push(socket)
    return socket
  })

  startDeriveFeed()
  sockets[0].emit('open')
  await flushAsyncWork()

  assert.ok(sent.some((payload) => payload.id === 'sub-BTC-0'))
  assert.ok(sent.some((payload) => payload.id === 'sub-ETH-0'))
})

test('removeDeriveViewer does not terminate an always-on feed', () => {
  const sockets = []

  __setDeriveWebSocketFactoryForTests((url) => {
    const socket = {
      url,
      readyState: 0,
      terminated: false,
      on() {},
      terminate() {
        socket.terminated = true
      },
    }
    sockets.push(socket)
    return socket
  })

  startDeriveFeed()
  removeDeriveViewer('BTC')

  assert.equal(sockets[0].terminated, false)
})

test('startDeriveFeed is idempotent', () => {
  const sockets = []

  __setDeriveWebSocketFactoryForTests((url) => {
    const socket = {
      url,
      readyState: 0,
      on() {},
      terminate() {},
    }
    sockets.push(socket)
    return socket
  })

  startDeriveFeed()
  startDeriveFeed()

  assert.equal(sockets.length, 1)
})
