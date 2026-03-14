import test from 'node:test'
import assert from 'node:assert/strict'

import { getRuntimeConfig, isCorsOriginAllowed } from './lib/runtime-config.js'

test('private mode allows local development origins', () => {
  const config = getRuntimeConfig({})

  assert.equal(isCorsOriginAllowed('http://localhost:3000', config), true)
  assert.equal(isCorsOriginAllowed('http://127.0.0.1:3000', config), true)
  assert.equal(isCorsOriginAllowed(undefined, config), true)
})

test('public mode uses configured CORS origin allowlist', () => {
  const config = getRuntimeConfig({
    APP_MODE: 'public',
    CORS_ORIGINS: 'https://app.example.com, https://www.example.com ',
  })

  assert.deepEqual(config.corsOrigins, [
    'https://app.example.com',
    'https://www.example.com',
  ])
  assert.equal(isCorsOriginAllowed('https://app.example.com', config), true)
  assert.equal(isCorsOriginAllowed('https://www.example.com', config), true)
})

test('public mode rejects disallowed origins but allows missing origin', () => {
  const config = getRuntimeConfig({
    APP_MODE: 'public',
    CORS_ORIGINS: 'https://app.example.com',
  })

  assert.equal(isCorsOriginAllowed('https://evil.example.com', config), false)
  assert.equal(isCorsOriginAllowed(undefined, config), true)
})
