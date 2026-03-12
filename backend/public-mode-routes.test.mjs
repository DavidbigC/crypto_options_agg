import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { registerOptionalRoutes } from './lib/optional-routes.js'

function listRoutes(app) {
  return (app._router?.stack ?? [])
    .filter((layer) => layer.route?.path)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
    }))
}

function createApp(runtimeConfig) {
  const app = express()
  app.use(express.json())
  app.get('/api/health', (req, res) => res.json({ status: 'healthy' }))
  registerOptionalRoutes(app, {
    runtimeConfig,
    okxPortfolioService: {
      fetchPortfolio: async () => ({ exchange: 'okx' }),
    },
    bybitPortfolioService: {
      fetchPortfolio: async () => ({ exchange: 'bybit' }),
    },
    buildCombinedResponse: () => ({ spotPrice: 80000 }),
    runOptimizer: () => [{ ok: true }],
    futuresCache: {},
  })
  app.use('*', (req, res) => res.status(404).json({ error: 'Route not found' }))
  return app
}

test('public mode does not mount portfolio or optimizer routes', () => {
  const app = createApp({
    enablePortfolio: false,
    enableOptimizer: false,
  })
  const routes = listRoutes(app)

  assert.deepEqual(routes, [
    { path: '/api/health', methods: ['get'] },
  ])
})

test('private mode mounts portfolio and optimizer routes', () => {
  const app = createApp({
    enablePortfolio: true,
    enableOptimizer: true,
  })
  const routes = listRoutes(app)

  assert.deepEqual(routes, [
    { path: '/api/health', methods: ['get'] },
    { path: '/api/portfolio/okx', methods: ['get'] },
    { path: '/api/portfolio/bybit', methods: ['get'] },
    { path: '/api/optimizer/:coin', methods: ['post'] },
  ])
})
