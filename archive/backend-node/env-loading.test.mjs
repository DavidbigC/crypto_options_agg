import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { getEnvPaths } from './lib/env-paths.js'
import { getRuntimeConfig } from './lib/runtime-config.js'

test('getEnvPaths includes backend and project root env files', () => {
  const backendDir = '/tmp/project/backend'
  const paths = getEnvPaths(backendDir)

  assert.deepEqual(paths, [
    path.join(backendDir, '.env'),
    path.join('/tmp/project', '.env'),
  ])
})

test('getRuntimeConfig defaults to private mode with sensitive features enabled', () => {
  const config = getRuntimeConfig({})

  assert.equal(config.appMode, 'private')
  assert.equal(config.loadDotenv, true)
  assert.equal(config.enablePortfolio, true)
  assert.equal(config.enableOptimizer, true)
})

test('getRuntimeConfig disables dotenv and sensitive features in public mode', () => {
  const config = getRuntimeConfig({ APP_MODE: 'public' })

  assert.equal(config.appMode, 'public')
  assert.equal(config.loadDotenv, false)
  assert.equal(config.enablePortfolio, false)
  assert.equal(config.enableOptimizer, false)
})

test('getRuntimeConfig allows explicit flag overrides', () => {
  const config = getRuntimeConfig({
    APP_MODE: 'public',
    LOAD_DOTENV: 'true',
    ENABLE_PORTFOLIO: 'true',
    ENABLE_OPTIMIZER: 'false',
  })

  assert.equal(config.appMode, 'public')
  assert.equal(config.loadDotenv, true)
  assert.equal(config.enablePortfolio, true)
  assert.equal(config.enableOptimizer, false)
})
