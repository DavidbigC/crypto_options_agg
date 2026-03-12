export function registerOptionalRoutes(app, {
  runtimeConfig,
  okxPortfolioService,
  bybitPortfolioService,
  buildCombinedResponse,
  runOptimizer,
  futuresCache,
} = {}) {
  if (runtimeConfig?.enablePortfolio) {
    app.get('/api/portfolio/okx', async (req, res) => {
      try {
        const portfolio = await okxPortfolioService.fetchPortfolio()
        res.json(portfolio)
      } catch (error) {
        const message = error?.message || 'Internal server error'
        const status = /missing okx credentials/i.test(message) ? 503 : 502
        res.status(status).json({ error: message })
      }
    })

    app.get('/api/portfolio/bybit', async (req, res) => {
      try {
        const portfolio = await bybitPortfolioService.fetchPortfolio()
        res.json(portfolio)
      } catch (error) {
        const message = error?.message || 'Internal server error'
        const status = /missing bybit credentials/i.test(message) ? 503 : 502
        res.status(status).json({ error: message })
      }
    })
  }

  if (runtimeConfig?.enableOptimizer) {
    app.post('/api/optimizer/:coin', (req, res) => {
      const coin = req.params.coin.toUpperCase()
      const validCoins = ['BTC', 'ETH', 'SOL']
      if (!validCoins.includes(coin)) return res.status(400).json({ error: `Unsupported coin: ${coin}` })

      const validExchanges = ['bybit', 'okx', 'deribit']
      const { targets = {}, maxCost = 0, maxLegs = 4, targetExpiry = null, exchanges: rawExchanges } = req.body
      const exchanges = Array.isArray(rawExchanges)
        ? rawExchanges.filter((exchange) => validExchanges.includes(exchange))
        : validExchanges
      const activeExchanges = exchanges.length > 0 ? exchanges : validExchanges

      try {
        const combined = buildCombinedResponse(coin)
        if (!combined) return res.json([])

        const spotPrice = combined.spotPrice || 0
        const futures = futuresCache[coin] ?? []
        const results = runOptimizer(
          combined,
          spotPrice,
          futures,
          targets,
          maxCost,
          Math.min(maxLegs, 6),
          targetExpiry || null,
          activeExchanges,
        )
        return res.json(results)
      } catch (error) {
        return res.status(500).json({ error: error.message })
      }
    })
  }
}
