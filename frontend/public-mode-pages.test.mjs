import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getHeaderLinks,
  getPublicRuntime,
  isOptimizerEnabled,
  isPortfolioEnabled,
} from './lib/publicRuntime.js'

test('public runtime defaults to private mode with sensitive pages enabled', () => {
  const runtime = getPublicRuntime({})

  assert.equal(runtime.appMode, 'private')
  assert.equal(isPortfolioEnabled({}), true)
  assert.equal(isOptimizerEnabled({}), true)
})

test('public runtime disables portfolio and optimizer in public mode by default', () => {
  const runtime = getPublicRuntime({ NEXT_PUBLIC_APP_MODE: 'public' })
  const links = getHeaderLinks({ NEXT_PUBLIC_APP_MODE: 'public' })

  assert.equal(runtime.appMode, 'public')
  assert.equal(runtime.portfolioEnabled, false)
  assert.equal(runtime.optimizerEnabled, false)
  assert.equal(links.some((link) => link.href === '/portfolio'), false)
  assert.equal(links.some((link) => link.href === '/optimizer'), false)
})

test('public runtime honors explicit client-side feature overrides', () => {
  const env = {
    NEXT_PUBLIC_APP_MODE: 'public',
    NEXT_PUBLIC_ENABLE_PORTFOLIO: 'true',
    NEXT_PUBLIC_ENABLE_OPTIMIZER: 'false',
  }

  assert.equal(isPortfolioEnabled(env), true)
  assert.equal(isOptimizerEnabled(env), false)
})
