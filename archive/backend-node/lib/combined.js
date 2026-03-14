export function buildCombinedResponse(baseCoin, deps) {
  const {
    bybitApi,
    bybitTickerCache,
    bybitSpotCache,
    okxCache,
    okxTickerCache,
    okxSpotCache,
    parseOkxInstId,
    buildDeribitResponse,
    buildDeriveResponse,
    binanceCache,
    binanceSpotCache,
    parseBinanceSymbol,
  } = deps

  const okxFamily = `${baseCoin}-USD`
  const bybitTickers = Object.values(bybitTickerCache[baseCoin] ?? {})
  const bybitSpot = bybitSpotCache[baseCoin] ?? 0
  const okxFamilyCache = okxCache[okxFamily] ?? {}
  const okxFamilyTickers = okxTickerCache[okxFamily] ?? {}
  const okxSpot = okxSpotCache[`${baseCoin}-USDT`] ?? 0
  const deriveResp = buildDeriveResponse(baseCoin)
  const deriveSpot = deriveResp?.spotPrice ?? 0
  const spotPrice = bybitSpot || okxSpot || deriveSpot

  const merged = {}
  const forwardPrices = {}

  const ensure = (key) => {
    if (!merged[key]) {
      merged[key] = {
        bestBid: 0,
        bestBidEx: null,
        bestAsk: 0,
        bestAskEx: null,
        prices: {
          bybit: { bid: 0, ask: 0 },
          okx: { bid: 0, ask: 0 },
          deribit: { bid: 0, ask: 0 },
          derive: { bid: 0, ask: 0 },
          binance: { bid: 0, ask: 0 },
        },
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        markVol: 0,
        bidVol: 0,
        askVol: 0,
      }
    }
    return merged[key]
  }

  for (const ticker of bybitTickers) {
    const parsed = bybitApi.parseOptionSymbol(ticker.symbol)
    if (!parsed) continue
    const key = `${parsed.expiryDate}|${parsed.strikePrice}|${parsed.optionType.toLowerCase()}`
    const entry = ensure(key)
    const bid = parseFloat(ticker.bid1Price || 0)
    const ask = parseFloat(ticker.ask1Price || 0)
    entry.prices.bybit = { bid, ask }
    if (bid > entry.bestBid) { entry.bestBid = bid; entry.bestBidEx = 'bybit' }
    if (ask > 0 && (entry.bestAsk === 0 || ask < entry.bestAsk)) { entry.bestAsk = ask; entry.bestAskEx = 'bybit' }
    const bybitFwd = parseFloat(ticker.underlyingPrice || 0)
    if (bybitFwd > 0 && !forwardPrices[parsed.expiryDate]) forwardPrices[parsed.expiryDate] = bybitFwd
    entry.delta = parseFloat(ticker.delta || 0)
    entry.gamma = parseFloat(ticker.gamma || 0)
    entry.theta = parseFloat(ticker.theta || 0)
    entry.vega = parseFloat(ticker.vega || 0)
    const bMarkVol = parseFloat(ticker.impliedVolatility || 0)
    const bBidVol = parseFloat(ticker.bid1Iv || 0)
    const bAskVol = parseFloat(ticker.ask1Iv || 0)
    if (bMarkVol > 0) entry.markVol = bMarkVol
    if (bBidVol > 0) entry.bidVol = bBidVol
    if (bAskVol > 0) entry.askVol = bAskVol
  }

  for (const [instId, item] of Object.entries(okxFamilyCache)) {
    const parsed = parseOkxInstId(instId)
    if (!parsed) continue
    const key = `${parsed.expiryDate}|${parsed.strikePrice}|${parsed.optionType}`
    const entry = ensure(key)
    const ticker = okxFamilyTickers[instId] ?? {}
    const bid = parseFloat(ticker.bidPx || 0) * (okxSpot || 1)
    const ask = parseFloat(ticker.askPx || 0) * (okxSpot || 1)
    entry.prices.okx = { bid, ask }
    if (bid > entry.bestBid) { entry.bestBid = bid; entry.bestBidEx = 'okx' }
    if (ask > 0 && (entry.bestAsk === 0 || ask < entry.bestAsk)) { entry.bestAsk = ask; entry.bestAskEx = 'okx' }
    const okxFwd = parseFloat(item.fwdPx || 0)
    if (okxFwd > 0 && !forwardPrices[parsed.expiryDate]) forwardPrices[parsed.expiryDate] = okxFwd
    const delta = parseFloat(item.delta || 0)
    if (delta !== 0) {
      entry.delta = delta
      entry.gamma = okxSpot > 0 ? parseFloat(item.gamma || 0) / okxSpot : 0
      entry.theta = parseFloat(item.theta || 0) * okxSpot
      entry.vega = parseFloat(item.vega || 0) * okxSpot
    }
    const oMarkVol = parseFloat(item.markVol || 0)
    const oBidVol = parseFloat(item.bidVol || 0)
    const oAskVol = parseFloat(item.askVol || 0)
    if (oMarkVol > 0) entry.markVol = oMarkVol
    if (oBidVol > 0) entry.bidVol = oBidVol
    if (oAskVol > 0) entry.askVol = oAskVol
  }

  const deribitResp = buildDeribitResponse(baseCoin)
  if (deribitResp) {
    for (const [expiryDate, dateData] of Object.entries(deribitResp.data)) {
      if (dateData.forwardPrice > 0 && !forwardPrices[expiryDate]) {
        forwardPrices[expiryDate] = dateData.forwardPrice
      }
      for (const contract of [...dateData.calls, ...dateData.puts]) {
        const key = `${expiryDate}|${contract.strike}|${contract.optionType}`
        const entry = ensure(key)
        entry.prices.deribit = { bid: contract.bid, ask: contract.ask }
        if (contract.bid > entry.bestBid) { entry.bestBid = contract.bid; entry.bestBidEx = 'deribit' }
        if (contract.ask > 0 && (entry.bestAsk === 0 || contract.ask < entry.bestAsk)) { entry.bestAsk = contract.ask; entry.bestAskEx = 'deribit' }
        if (contract.delta !== 0) {
          entry.delta = contract.delta
          entry.gamma = contract.gamma
          entry.theta = contract.theta
          entry.vega = contract.vega
        }
        if (contract.markVol > 0) entry.markVol = contract.markVol
        if (contract.bidVol > 0) entry.bidVol = contract.bidVol
        if (contract.askVol > 0) entry.askVol = contract.askVol
      }
    }
  }

  if (deriveResp) {
    for (const [expiryDate, dateData] of Object.entries(deriveResp.data)) {
      for (const contract of [...dateData.calls, ...dateData.puts]) {
        const key = `${expiryDate}|${contract.strike}|${contract.optionType}`
        const entry = ensure(key)
        entry.prices.derive = { bid: contract.bid, ask: contract.ask }
        if (contract.bid > entry.bestBid) { entry.bestBid = contract.bid; entry.bestBidEx = 'derive' }
        if (contract.ask > 0 && (entry.bestAsk === 0 || contract.ask < entry.bestAsk)) { entry.bestAsk = contract.ask; entry.bestAskEx = 'derive' }
        if (contract.delta !== 0) {
          entry.delta = contract.delta
          entry.gamma = contract.gamma
          entry.theta = contract.theta
          entry.vega = contract.vega
        }
        if (contract.markVol > 0) entry.markVol = contract.markVol
        if (contract.bidVol > 0) entry.bidVol = contract.bidVol
        if (contract.askVol > 0) entry.askVol = contract.askVol
      }
    }
  }

  for (const [symbol, item] of Object.entries(binanceCache[baseCoin] ?? {})) {
    const parsed = parseBinanceSymbol(symbol)
    if (!parsed) continue
    const key = `${parsed.expiryDate}|${parsed.strikePrice}|${parsed.optionType}`
    const entry = ensure(key)
    const bid = parseFloat(item.bo ?? 0)
    const ask = parseFloat(item.ao ?? 0)
    entry.prices.binance = { bid, ask }
    if (bid > entry.bestBid) { entry.bestBid = bid; entry.bestBidEx = 'binance' }
    if (ask > 0 && (entry.bestAsk === 0 || ask < entry.bestAsk)) { entry.bestAsk = ask; entry.bestAskEx = 'binance' }
    const delta = parseFloat(item.d ?? 0)
    if (delta !== 0) {
      entry.delta = delta
      entry.gamma = parseFloat(item.g ?? 0)
      entry.theta = parseFloat(item.t ?? 0)
      entry.vega = parseFloat(item.v ?? 0)
    }
    const bMarkVol = parseFloat(item.vo ?? 0)
    const bBidVol = parseFloat(item.b ?? 0)
    const bAskVol = parseFloat(item.a ?? 0)
    if (bMarkVol > 0) entry.markVol = bMarkVol
    if (bBidVol > 0) entry.bidVol = bBidVol
    if (bAskVol > 0) entry.askVol = bAskVol
    const bnSpot = binanceSpotCache[baseCoin] ?? 0
    if (bnSpot > 0 && !forwardPrices[parsed.expiryDate]) forwardPrices[parsed.expiryDate] = bnSpot
  }

  const optionsByDate = {}
  for (const [key, entry] of Object.entries(merged)) {
    const [expiryDate, strikeStr, optionType] = key.split('|')
    const contract = { strike: parseFloat(strikeStr), optionType, ...entry }
    if (!optionsByDate[expiryDate]) {
      optionsByDate[expiryDate] = { calls: [], puts: [], forwardPrice: forwardPrices[expiryDate] ?? 0 }
    }
    if (optionType === 'call') optionsByDate[expiryDate].calls.push(contract)
    else optionsByDate[expiryDate].puts.push(contract)
  }

  const sortedDates = Object.keys(optionsByDate).sort()
  const expirationCounts = {}
  for (const date of sortedDates) {
    expirationCounts[date] = { calls: optionsByDate[date].calls.length, puts: optionsByDate[date].puts.length }
  }
  return { spotPrice, expirations: sortedDates, expirationCounts, data: optionsByDate }
}
