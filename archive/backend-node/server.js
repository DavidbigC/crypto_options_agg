#!/usr/bin/env node
/**
 * Node.js/Express backend API to serve options data from Bybit
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BybitOptionsAPI } from './lib/bybit-api-axios.js';
import { mockSpotPrices, getMockOptionsData } from './lib/mock-data.js';
import {
  calculateTimeToExpiration,
  groupOptionsByStrike,
  findATMStrike,
  sanitizeOptionData
} from './lib/utils.js';
import { okxCache, startOkxWebSocket } from './lib/okx-ws.js'
import { binanceCache, binanceSpotCache, startBinanceWS, setBinanceUpdateCallback } from './lib/binance-ws.js'
import { startDeribitPolling, buildDeribitResponse } from './lib/deribit.js';
import { startDeribitWS, setDeribitUpdateCallback } from './lib/deribit-ws.js';
import { buildDeriveResponse } from './lib/derive.js';
import { deriveTickersCache, deriveSpotCache, setDeriveUpdateCallback, startDeriveFeed } from './lib/derive-ws.js'
import { futuresCache, startFuturesPolling } from './lib/futures.js';
import { analysisCache, updateAnalysisCache } from './lib/analysis.js'
import { arbCache, updateArbCache } from './lib/arbs.js'
import { scannerCache, updateScannerCache, computeGammaRows, computeVegaRows } from './lib/scanners.js'
import {
  createPolymarketRouteHandler,
  createPolymarketService,
  createPolymarketSurfaceRouteHandler,
} from './lib/polymarket/service.js'
import {
  lookupPolymarketPrice,
  setPolymarketUpdateCallback,
  startPolymarketWS,
  subscribePolymarketAssetIds,
} from './lib/polymarket/ws.js'

import { runOptimizer } from './lib/optimizer.js'
import { createOkxPortfolioService } from './lib/okx-portfolio.js'
import { createBybitPortfolioService } from './lib/bybit-portfolio.js'
import { getEnvPaths } from './lib/env-paths.js'
import { buildCombinedResponse as buildCombinedResponseFromLib } from './lib/combined.js'
import { getRuntimeConfig, isCorsOriginAllowed } from './lib/runtime-config.js'
import { registerOptionalRoutes } from './lib/optional-routes.js'
import { createRateLimiter } from './lib/rate-limit.js'
import { createPolymarketSurfaceBroadcaster } from './lib/polymarket-sse.js'
import { attachSseLease } from './lib/sse-lease.js'
import { isValidStreamCoin } from './lib/stream-params.js'


const backendDir = path.dirname(fileURLToPath(import.meta.url))
const runtimeConfig = getRuntimeConfig()
if (runtimeConfig.loadDotenv) {
  for (const envPath of getEnvPaths(backendDir)) {
    dotenv.config({ path: envPath })
  }
}

const app = express();
const PORT = process.env.PORT || 3500;
const okxPortfolioService = runtimeConfig.enablePortfolio
  ? createOkxPortfolioService({ env: process.env })
  : null
const bybitPortfolioService = runtimeConfig.enablePortfolio
  ? createBybitPortfolioService({ env: process.env })
  : null
const polymarketService = createPolymarketService({ livePriceLookup: lookupPolymarketPrice })
const polymarketRouteHandler = createPolymarketRouteHandler({ service: polymarketService })
const polymarketSurfaceRouteHandler = createPolymarketSurfaceRouteHandler({ service: polymarketService })

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (isCorsOriginAllowed(origin, runtimeConfig)) return callback(null, true)
    return callback(new Error('Origin not allowed by CORS'))
  },
}));
app.use(express.json());
if (runtimeConfig.appMode === 'public') {
  app.use('/api', createRateLimiter({ limit: 120, windowMs: 60_000 }))
  app.use('/api/stream', createRateLimiter({ limit: 20, windowMs: 60_000 }))
}

// Initialize Bybit API
const bybitApi = new BybitOptionsAPI();
const DEMO_MODE = false; // Force live mode - no mock data

console.log(`🔧 Server starting in ${DEMO_MODE ? 'DEMO' : 'LIVE'} mode`);

// ─── Response Builders (used by REST routes and SSE) ─────────────────────────

function buildBybitResponse(baseCoin) {
  const tickers   = Object.values(bybitTickerCache[baseCoin] ?? {})
  const spotPrice = bybitSpotCache[baseCoin] ?? 0
  if (tickers.length === 0) return null
  const optionsByDate = {}
  for (const ticker of tickers) {
    const parsed = bybitApi.parseOptionSymbol(ticker.symbol || '')
    if (!parsed) continue
    const optionData = {
      symbol:            ticker.symbol,
      strike:            parsed.strikePrice,
      optionType:        parsed.optionType.toLowerCase(),
      bid:               parseFloat(ticker.bid1Price || 0),
      ask:               parseFloat(ticker.ask1Price || 0),
      last:              parseFloat(ticker.lastPrice || 0),
      volume:            parseFloat(ticker.volume24h || 0),
      bidSize:           parseFloat(ticker.bid1Size || 0),
      askSize:           parseFloat(ticker.ask1Size || 0),
      delta:             parseFloat(ticker.delta || 0),
      gamma:             parseFloat(ticker.gamma || 0),
      theta:             parseFloat(ticker.theta || 0),
      vega:              parseFloat(ticker.vega || 0),
      impliedVolatility: parseFloat(ticker.impliedVolatility || 0),
      markVol:           parseFloat(ticker.impliedVolatility || 0),
      bidVol:            parseFloat(ticker.bid1Iv || 0),
      askVol:            parseFloat(ticker.ask1Iv || 0),
      openInterest:      parseFloat(ticker.openInterest || 0),
      markPrice:         parseFloat(ticker.markPrice || 0),
    }
    const expiry = parsed.expiryDate
    if (!optionsByDate[expiry]) optionsByDate[expiry] = { calls: [], puts: [], forwardPrice: parseFloat(ticker.underlyingPrice || 0) }
    if (parsed.optionType.toLowerCase() === 'call') optionsByDate[expiry].calls.push(optionData)
    else optionsByDate[expiry].puts.push(optionData)
  }
  const sortedDates = Object.keys(optionsByDate).sort()
  const expirationCounts = {}
  for (const date of sortedDates) {
    expirationCounts[date] = { calls: optionsByDate[date].calls.length, puts: optionsByDate[date].puts.length }
  }
  return { spotPrice, expirations: sortedDates, expirationCounts, data: optionsByDate }
}

function buildOkxResponse(instFamily) {
  const familyCache = okxCache[instFamily]
  if (!familyCache) return null
  const entries = Object.entries(familyCache)
  if (entries.length === 0) console.warn(`OKX cache empty for ${instFamily} — WS may still be connecting`)
  const spotSymbolMap = { 'BTC-USD': 'BTC-USDT', 'ETH-USD': 'ETH-USDT', 'SOL-USD': 'SOL-USDT' }
  const spotPrice        = okxSpotCache[spotSymbolMap[instFamily]] ?? 0
  const familyTickerCache = okxTickerCache[instFamily] ?? {}
  const optionsByDate = {}
  for (const [instId, item] of entries) {
    const parsed = parseOkxInstId(instId)
    if (!parsed) continue
    const ticker = familyTickerCache[instId] ?? {}
    const contract = {
      symbol:            instId,
      strike:            parsed.strikePrice,
      optionType:        parsed.optionType,
      bid:               parseFloat(ticker.bidPx || 0),
      ask:               parseFloat(ticker.askPx || 0),
      last:              parseFloat(ticker.last || 0),
      volume:            parseFloat(ticker.vol24h || item.vol24h || 0),
      bidSize:           parseFloat(ticker.bidSz || 0),
      askSize:           parseFloat(ticker.askSz || 0),
      delta:             parseFloat(item.delta || 0),
      gamma:             spotPrice > 0 ? parseFloat(item.gamma || 0) / spotPrice : 0,
      theta:             parseFloat(item.theta || 0) * spotPrice,
      vega:              parseFloat(item.vega || 0) * spotPrice,
      impliedVolatility: parseFloat(item.markVol || 0),
      openInterest:      parseFloat(item.oi || 0),
      markPrice:         0,
      markVol:           parseFloat(item.markVol || 0),
      bidVol:            parseFloat(item.bidVol || 0),
      askVol:            parseFloat(item.askVol || 0),
    }
    const expiry = parsed.expiryDate
    if (!optionsByDate[expiry]) {
      const fwdPrice = parseFloat(item.fwdPx || 0)
      optionsByDate[expiry] = { calls: [], puts: [], forwardPrice: fwdPrice }
    }
    if (parsed.optionType === 'call') optionsByDate[expiry].calls.push(contract)
    else optionsByDate[expiry].puts.push(contract)
  }
  const sortedDates = Object.keys(optionsByDate).sort()
  const expirationCounts = {}
  for (const date of sortedDates) {
    expirationCounts[date] = { calls: optionsByDate[date].calls.length, puts: optionsByDate[date].puts.length }
  }
  return { spotPrice, expirations: sortedDates, expirationCounts, data: optionsByDate }
}

function buildCombinedResponse(baseCoin) {
  return buildCombinedResponseFromLib(baseCoin, {
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
  })
}

// ─── SSE Infrastructure ───────────────────────────────────────────────────────

const sseClients = new Map() // key: 'exchange:coin' → Map<ServerResponse, {expiry}>
const polymarketTokenAssetMap = new Map()
const polymarketSurfaceBroadcaster = createPolymarketSurfaceBroadcaster({
  service: polymarketService,
  clientsByKey: sseClients,
  registerAssetTokens: registerPolymarketAssetTokens,
  subscribeAssetIds: subscribePolymarketAssetIds,
})

const VALID_EXCHANGES = new Set(['bybit', 'okx', 'deribit', 'derive', 'binance', 'combined'])
const SSE_LEASE_MS = 30 * 60 * 1000

// Filter full response down to a single expiry's data (keeps metadata intact).
// Reduces payload from ~220KB to ~30KB when a client is watching one expiry.
function filterByExpiry(data, expiry) {
  if (!expiry || !data?.data) return data
  return { ...data, data: { [expiry]: data.data[expiry] ?? { calls: [], puts: [] } } }
}

function emitSSE(exchange, coin, data) {
  const key     = `${exchange}:${coin}`
  const clients = sseClients.get(key)
  if (!clients?.size) return
  const payload = JSON.stringify(data)
  for (const [res, opts] of clients.entries()) {
    if (res.writableEnded) {
      clients.delete(res)
      continue
    }
    try {
      const out = opts.expiry ? `data: ${JSON.stringify(filterByExpiry(data, opts.expiry))}\n\n` : `data: ${payload}\n\n`
      res.write(out)
    } catch (err) {
      console.error(`SSE write error (${key}), removing client:`, err.message)
      clients.delete(res)
    }
  }
}

function hasSSEClients(exchange, coin) {
  return (sseClients.get(`${exchange}:${coin}`)?.size ?? 0) > 0
}

function registerPolymarketAssetTokens(asset, surface) {
  const horizons = Object.values(surface?.horizons ?? {})
  for (const horizon of horizons) {
    for (const market of horizon?.sourceMarkets ?? []) {
      if (!market?.tokenId) continue
      const tokenId = String(market.tokenId)
      if (!polymarketTokenAssetMap.has(tokenId)) polymarketTokenAssetMap.set(tokenId, new Set())
      polymarketTokenAssetMap.get(tokenId).add(asset)
    }
  }
}

async function emitPolymarketSurface(asset) {
  try {
    await polymarketSurfaceBroadcaster.broadcastAsset(asset)
  } catch (err) {
    console.error(`Polymarket SSE write error (${asset}):`, err.message)
  }
}

function makeThrottledEmitter(exchange, getDataFn, ms) {
  const timers    = {}
  const lastFired = {}
  return (coin) => {
    const now  = Date.now()
    const last = lastFired[coin] ?? 0
    const remaining = ms - (now - last)
    if (remaining <= 0) {
      // Enough time has passed — fire immediately
      lastFired[coin] = now
      const data = getDataFn(coin)
      if (data) emitSSE(exchange, coin, data)
    } else {
      // Schedule one trailing fire at end of window
      clearTimeout(timers[coin])
      timers[coin] = setTimeout(() => {
        lastFired[coin] = Date.now()
        const data = getDataFn(coin)
        if (data) emitSSE(exchange, coin, data)
      }, remaining)
    }
  }
}

function getDataForExchange(exchange, coin) {
  switch (exchange) {
    case 'bybit':    return buildBybitResponse(coin)
    case 'okx':      return buildOkxResponse(coin)   // coin = 'BTC-USD' etc.
    case 'deribit':  return buildDeribitResponse(coin)
    case 'derive':   return buildDeriveResponse(coin)
    case 'binance':  return buildBinanceResponse(coin)
    case 'combined': return buildCombinedResponse(coin)
    default:         return null
  }
}

// Routes
app.get('/api/options/:baseCoin', async (req, res) => {
  try {
    const baseCoin = req.params.baseCoin.toUpperCase();
    
    // Use mock data if in demo mode or if API fails
    if (DEMO_MODE) {
      console.log(`📊 Returning mock data for ${baseCoin}`);
      const mockData = getMockOptionsData(baseCoin);
      if (mockData) {
        return res.json(mockData);
      } else {
        return res.status(404).json({
          error: `No mock data available for ${baseCoin}`
        });
      }
    }
    
    // Try live API first
    let spotPrice, tickers;
    try {
      const spotSymbol = `${baseCoin}USDT`;
      spotPrice = await bybitApi.getSpotPrice(spotSymbol);
      tickers = await bybitApi.getOptionsTickers(baseCoin);
    } catch (apiError) {
      console.warn(`⚠️  API failed for ${baseCoin}, falling back to mock data:`, apiError.message);
      const mockData = getMockOptionsData(baseCoin);
      if (mockData) {
        return res.json(mockData);
      } else {
        throw apiError;
      }
    }
    
    if (!tickers || tickers.length === 0) {
      return res.status(404).json({
        error: `No ${baseCoin} options data available`
      });
    }
    
    // Group options by expiration date
    const optionsByDate = {};
    
    for (const ticker of tickers) {
      const symbol = ticker.symbol || '';
      const parsed = bybitApi.parseOptionSymbol(symbol);
      
      if (!parsed) continue;
      
      const optionData = {
        symbol,
        strike: parsed.strikePrice,
        optionType: parsed.optionType.toLowerCase(),
        bid: parseFloat(ticker.bid1Price || 0),
        ask: parseFloat(ticker.ask1Price || 0),
        last: parseFloat(ticker.lastPrice || 0),
        volume: parseFloat(ticker.volume24h || 0),
        bidSize: parseFloat(ticker.bid1Size || 0),
        askSize: parseFloat(ticker.ask1Size || 0),
        delta: parseFloat(ticker.delta || 0),
        gamma: parseFloat(ticker.gamma || 0),
        theta: parseFloat(ticker.theta || 0),
        vega: parseFloat(ticker.vega || 0),
        impliedVolatility: parseFloat(ticker.impliedVolatility || 0),
        openInterest: parseFloat(ticker.openInterest || 0),
        markPrice: parseFloat(ticker.markPrice || 0)
      };
      
      const expiry = parsed.expiryDate;
      
      if (!optionsByDate[expiry]) {
        optionsByDate[expiry] = { calls: [], puts: [] };
      }
      
      if (parsed.optionType.toLowerCase() === 'call') {
        optionsByDate[expiry].calls.push(optionData);
      } else {
        optionsByDate[expiry].puts.push(optionData);
      }
    }
    
    // Sort dates and prepare response
    const sortedDates = Object.keys(optionsByDate).sort();
    
    // Calculate counts per expiration
    const expirationCounts = {};
    for (const date of sortedDates) {
      expirationCounts[date] = {
        calls: optionsByDate[date].calls.length,
        puts: optionsByDate[date].puts.length
      };
    }
    
    const responseData = {
      spotPrice,
      expirations: sortedDates,
      expirationCounts,
      data: optionsByDate
    };
    
    res.json(responseData);
    
  } catch (error) {
    console.error('Error fetching options data:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

app.get('/api/spot/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    
    // Always try live data first (demo mode disabled)
    
    try {
      const price = await bybitApi.getSpotPrice(symbol);
      res.json({ symbol, price });
    } catch (apiError) {
      console.warn(`⚠️  Spot price API failed for ${symbol}, using mock data:`, apiError.message);
      const price = mockSpotPrices[symbol] || 0;
      res.json({ symbol, price });
    }
    
  } catch (error) {
    console.error('Error fetching spot price:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

// Get options chain for a specific expiration
app.get('/api/options/:baseCoin/:expiration', async (req, res) => {
  try {
    const { baseCoin, expiration } = req.params;
    
    // Get the full options data first
    const fullDataResponse = await fetch(`http://localhost:${PORT}/api/options/${baseCoin}`);
    const fullData = await fullDataResponse.json();
    
    if (!fullData.data[expiration]) {
      return res.status(404).json({
        error: `No data found for ${baseCoin} expiration ${expiration}`
      });
    }
    
    const chainData = fullData.data[expiration];
    const spotPrice = fullData.spotPrice;
    
    // Add additional calculations
    const strikes = [...new Set([
      ...chainData.calls.map(c => c.strike),
      ...chainData.puts.map(p => p.strike)
    ])].sort((a, b) => a - b);
    
    const atmStrike = findATMStrike(strikes, spotPrice);
    const timeToExp = calculateTimeToExpiration(expiration);
    
    // Group by strikes for easier frontend consumption
    const groupedOptions = groupOptionsByStrike(chainData.calls, chainData.puts);
    
    res.json({
      expiration,
      spotPrice,
      atmStrike,
      timeToExpiration: timeToExp,
      totalCalls: chainData.calls.length,
      totalPuts: chainData.puts.length,
      strikes,
      options: groupedOptions,
      rawData: chainData
    });
    
  } catch (error) {
    console.error('Error fetching specific expiration data:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

// Get market statistics
app.get('/api/market-stats/:baseCoin', async (req, res) => {
  try {
    const baseCoin = req.params.baseCoin.toUpperCase();
    
    // Get options data
    const tickers = await bybitApi.getOptionsTickers(baseCoin);
    const spotPrice = await bybitApi.getSpotPrice(`${baseCoin}USDT`);
    
    if (!tickers || tickers.length === 0) {
      return res.status(404).json({
        error: `No ${baseCoin} options data available`
      });
    }
    
    // Calculate market statistics
    let totalCallVolume = 0;
    let totalPutVolume = 0;
    let totalCallOI = 0;
    let totalPutOI = 0;
    let avgIV = 0;
    let ivCount = 0;
    
    for (const ticker of tickers) {
      const parsed = bybitApi.parseOptionSymbol(ticker.symbol);
      if (!parsed) continue;
      
      const volume = parseFloat(ticker.volume24h || 0);
      const oi = parseFloat(ticker.openInterest || 0);
      const iv = parseFloat(ticker.impliedVolatility || 0);
      
      if (parsed.optionType.toLowerCase() === 'call') {
        totalCallVolume += volume;
        totalCallOI += oi;
      } else {
        totalPutVolume += volume;
        totalPutOI += oi;
      }
      
      if (iv > 0) {
        avgIV += iv;
        ivCount++;
      }
    }
    
    const putCallRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;
    const avgImpliedVol = ivCount > 0 ? avgIV / ivCount : 0;
    
    res.json({
      baseCoin,
      spotPrice,
      totalCallVolume,
      totalPutVolume,
      totalCallOI,
      totalPutOI,
      putCallRatio,
      averageImpliedVolatility: avgImpliedVol,
      totalContracts: tickers.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error fetching market stats:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

// Get multiple spot prices
app.get('/api/spots', async (req, res) => {
  try {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const prices = await bybitApi.getMultipleSpotPrices(symbols);
    
    res.json(prices);
    
  } catch (error) {
    console.error('Error fetching multiple spot prices:', error);
    res.status(500).json({
      error: error.message || 'Internal server error'
    });
  }
});

// Snapshot of what the frontend receives for a given coin/expiry
app.get('/api/bybit/snapshot/:coin', (req, res) => {
  const coin   = req.params.coin.toUpperCase()
  const expiry = req.query.expiry
  const data   = buildBybitResponse(coin)
  if (!data) return res.status(503).json({ error: 'Cache empty — wait for WS warm-up' })
  res.json(expiry ? filterByExpiry(data, expiry) : data)
})

app.get('/api/debug/bybit', (req, res) => {
  const coin    = (req.query.coin || 'BTC').toUpperCase()
  const expiry  = req.query.expiry  // e.g. 2026-03-08
  const cache   = bybitTickerCache[coin] ?? {}
  const symbols = Object.keys(cache)
  const expiries = [...new Set(
    symbols.map(s => bybitApi.parseOptionSymbol(s)?.expiryDate).filter(Boolean)
  )].sort()
  const forExpiry = expiry ? symbols.filter(s => {
    const p = bybitApi.parseOptionSymbol(s)
    return p?.expiryDate === expiry
  }) : []
  const sseKey     = `bybit:${coin}`
  const sseClients_ = sseClients.get(sseKey)
  const sseCount   = sseClients_?.size ?? 0
  const sseExpiries = sseClients_ ? [...sseClients_.values()].map(o => o.expiry) : []
  res.json({
    coin,
    cacheSymbols: symbols.length,
    spot: bybitSpotCache[coin],
    expiriesInCache: expiries,
    sseClients: sseCount,
    sseClientExpiries: sseExpiries,
    ...(expiry ? {
      queryExpiry: expiry,
      symbolsForExpiry: forExpiry.length,
      sampleSymbols: forExpiry.slice(0, 3),
      sampleData: forExpiry.slice(0, 2).map(s => cache[s]),
    } : {}),
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Bybit Options API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ─── OKX Helpers ────────────────────────────────────────────────────────────

function parseOkxInstId(instId) {
  // Format: BTC-USD-250328-70000-C
  const parts = instId.split('-');
  if (parts.length < 5) return null;
  try {
    const expRaw = parts[2]; // YYMMDD
    const year = '20' + expRaw.slice(0, 2);
    const month = expRaw.slice(2, 4);
    const day = expRaw.slice(4, 6);
    return {
      expiryDate: `${year}-${month}-${day}`,
      strikePrice: parseFloat(parts[3]),
      optionType: parts[4] === 'C' ? 'call' : 'put',
    };
  } catch {
    return null;
  }
}

async function fetchOkxSpotPrice(instId) {
  try {
    const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'okx-options-viewer/1.0' } });
    const json = await res.json();
    return parseFloat(json.data?.[0]?.last ?? 0);
  } catch {
    return 0;
  }
}

// ─── Binance Helpers ─────────────────────────────────────────────────────────

function parseBinanceSymbol(symbol) {
  // Format: BTC-250328-80000-C
  const parts = symbol.split('-')
  if (parts.length < 4) return null
  try {
    const expRaw = parts[1] // YYMMDD
    const year  = '20' + expRaw.slice(0, 2)
    const month = expRaw.slice(2, 4)
    const day   = expRaw.slice(4, 6)
    return {
      expiryDate:  `${year}-${month}-${day}`,
      strikePrice: parseFloat(parts[2]),
      optionType:  parts[3] === 'C' ? 'call' : 'put',
    }
  } catch {
    return null
  }
}

function buildBinanceResponse(baseCoin) {
  const cache     = binanceCache[baseCoin]
  const spotPrice = binanceSpotCache[baseCoin] ?? 0
  if (!cache || Object.keys(cache).length === 0) return null
  const optionsByDate = {}
  for (const [symbol, item] of Object.entries(cache)) {
    const parsed = parseBinanceSymbol(symbol)
    if (!parsed) continue
    const contract = {
      symbol,
      strike:            parsed.strikePrice,
      optionType:        parsed.optionType,
      bid:               parseFloat(item.bo ?? 0),
      ask:               parseFloat(item.ao ?? 0),
      last:              0,
      volume:            0,
      bidSize:           parseFloat(item.bq ?? 0),
      askSize:           parseFloat(item.aq ?? 0),
      delta:             parseFloat(item.d  ?? 0),
      gamma:             parseFloat(item.g  ?? 0),
      theta:             parseFloat(item.t  ?? 0),
      vega:              parseFloat(item.v  ?? 0),
      impliedVolatility: parseFloat(item.vo ?? 0),
      markVol:           parseFloat(item.vo ?? 0),
      bidVol:            parseFloat(item.b  ?? 0),
      askVol:            parseFloat(item.a  ?? 0),
      markPrice:         parseFloat(item.mp ?? 0),
      openInterest:      0,
    }
    const expiry = parsed.expiryDate
    if (!optionsByDate[expiry]) optionsByDate[expiry] = { calls: [], puts: [], forwardPrice: spotPrice }
    if (parsed.optionType === 'call') optionsByDate[expiry].calls.push(contract)
    else                              optionsByDate[expiry].puts.push(contract)
  }
  const sortedDates = Object.keys(optionsByDate).sort()
  const expirationCounts = {}
  for (const date of sortedDates) {
    expirationCounts[date] = { calls: optionsByDate[date].calls.length, puts: optionsByDate[date].puts.length }
  }
  return { spotPrice, expirations: sortedDates, expirationCounts, data: optionsByDate }
}

// ─── Bybit Background Cache (REST polling) ────────────────────────────────────
const bybitTickerCache = { BTC: {}, ETH: {}, SOL: {} }
const bybitSpotCache   = { BTC: 0,   ETH: 0,   SOL: 0 }

function normalizeRestTicker(t) {
  return {
    symbol:            t.symbol,
    bid1Price:         t.bid1Price       ?? '0',
    ask1Price:         t.ask1Price       ?? '0',
    lastPrice:         t.lastPrice       ?? '0',
    volume24h:         t.volume24h       ?? '0',
    bid1Size:          t.bid1Size        ?? '0',
    ask1Size:          t.ask1Size        ?? '0',
    delta:             t.delta           ?? '0',
    gamma:             t.gamma           ?? '0',
    theta:             t.theta           ?? '0',
    vega:              t.vega            ?? '0',
    impliedVolatility: t.markIv          ?? '0',
    bid1Iv:            t.bid1Iv          ?? '0',
    ask1Iv:            t.ask1Iv          ?? '0',
    openInterest:      t.openInterest    ?? '0',
    markPrice:         t.markPrice       ?? '0',
    underlyingPrice:   t.underlyingPrice ?? '0',
  }
}

async function pollBybit(coin) {
  try {
    const url  = `https://api.bybit.com/v5/market/tickers?category=option&baseCoin=${coin}`
    const res  = await fetch(url, { headers: { 'User-Agent': 'bybit-options-viewer/1.0' } })
    const json = await res.json()
    const list = json.result?.list ?? []
    if (!list.length) return
    for (const t of list) bybitTickerCache[coin][t.symbol] = normalizeRestTicker(t)
    const spot = parseFloat(list[0].indexPrice)
    if (spot > 0) bybitSpotCache[coin] = spot
    const data = buildBybitResponse(coin)
    if (data) {
      emitSSE('bybit', coin, data)
      updateAnalysisCache(`bybit:${coin}`, data, bybitSpotCache[coin] ?? 0)
      updateScannerCache(`bybit:${coin}`, data, bybitSpotCache[coin] ?? 0)
      if (hasSSEClients('combined', coin)) {
        const combined = buildCombinedResponse(coin)
        if (combined) {
          emitSSE('combined', coin, combined)
          updateArbCache(coin, combined, bybitSpotCache[coin] ?? 0, futuresCache[coin] ?? [])
        }
      }
    }
  } catch (err) {
    console.error(`Bybit REST poll error (${coin}):`, err.message)
  }
}

function startBybitPolling() {
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    pollBybit(coin)
    setInterval(() => pollBybit(coin), 1000)
  }
  console.log('Bybit REST polling started (1s per coin)')
}

// In-memory caches populated by background polling — shared across all requests
const okxTickerCache = {
  'BTC-USD': {},
  'ETH-USD': {},
};

const okxSpotCache = {
  'BTC-USDT': 0,
  'ETH-USDT': 0,
};

async function pollOkxTickers(instFamily) {
  try {
    const url = `https://www.okx.com/api/v5/market/tickers?instType=OPTION&instFamily=${instFamily}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'okx-options-viewer/1.0' } });
    const json = await res.json();
    const cache = okxTickerCache[instFamily];
    if (!cache) return;
    for (const t of json.data ?? []) {
      cache[t.instId] = t;
    }
    const coin = instFamily.split('-')[0]
    const okxResp = buildOkxResponse(instFamily)
    emitSSE('okx', instFamily, okxResp)
    updateAnalysisCache(`okx:${instFamily}`, okxResp, okxSpotCache[`${coin}-USDT`] ?? 0)
    updateScannerCache(`okx:${instFamily}`, okxResp, okxSpotCache[`${coin}-USDT`] ?? 0)
    if (hasSSEClients('combined', coin)) {
      const combined = buildCombinedResponse(coin)
      if (combined) {
        emitSSE('combined', coin, combined)
        updateArbCache(coin, combined, okxSpotCache[`${coin}-USDT`] ?? 0, futuresCache[coin] ?? [])
      }
    }
  } catch (err) {
    console.error(`OKX ticker poll error (${instFamily}):`, err.message);
  }
}

async function pollOkxSpots() {
  for (const instId of Object.keys(okxSpotCache)) {
    try {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'okx-options-viewer/1.0' } });
      const json = await res.json();
      const price = parseFloat(json.data?.[0]?.last ?? 0);
      if (price > 0) okxSpotCache[instId] = price;
    } catch (err) {
      console.error(`OKX spot poll error (${instId}):`, err.message);
    }
  }
}

function startOkxTickerPolling() {
  const FAMILIES = Object.keys(okxTickerCache);
  // Stagger initial polls so they don't fire simultaneously
  FAMILIES.forEach((family, i) => {
    setTimeout(() => {
      pollOkxTickers(family);
      setInterval(() => pollOkxTickers(family), 1000);
    }, i * 1000);
  });
  // Spot prices: poll every 5s (slower-moving than option prices)
  pollOkxSpots();
  setInterval(pollOkxSpots, 5000);
  console.log('OKX ticker + spot polling started');
}

// ─── OKX Routes ─────────────────────────────────────────────────────────────

app.get('/api/okx/spots', async (req, res) => {
  try {
    const [btc, eth, sol] = await Promise.all([
      fetchOkxSpotPrice('BTC-USDT'),
      fetchOkxSpotPrice('ETH-USDT'),
      fetchOkxSpotPrice('SOL-USDT'),
    ]);
    res.json({ 'BTC-USDT': btc, 'ETH-USDT': eth, 'SOL-USDT': sol });
  } catch (error) {
    console.error('Error fetching OKX spot prices:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/okx/options/:instFamily', (req, res) => {
  const instFamily = req.params.instFamily.toUpperCase()
  const response   = buildOkxResponse(instFamily)
  if (!response) return res.status(400).json({ error: `Unknown instFamily: ${instFamily}` })
  res.json(response)
});

// Debug: inspect raw OKX cache (remove once field names are confirmed)
app.get('/api/okx/debug/:instFamily', (req, res) => {
  const family = req.params.instFamily.toUpperCase();
  const cache = okxCache[family];
  if (!cache) return res.status(400).json({ error: 'Unknown family' });
  const { strike, expiry } = req.query;
  const keys = Object.keys(cache);
  let filtered = keys;
  if (strike) filtered = filtered.filter(k => k.includes(`-${strike}-`));
  if (expiry) filtered = filtered.filter(k => k.includes(`-${expiry}-`));
  const sample = filtered.slice(0, 5).map(k => {
    const item = cache[k];
    return {
      instId: k,
      normalized: {
        markVol: parseFloat(item.markVol || 0),
        bidVol: parseFloat(item.bidVol || 0),
        askVol: parseFloat(item.askVol || 0),
        delta: parseFloat(item.delta || 0),
      },
      raw: { markVol: item.markVol, bidVol: item.bidVol, askVol: item.askVol },
    };
  });
  res.json({ totalCached: keys.length, matched: filtered.length, sample });
});

// ─── Combined Route ──────────────────────────────────────────────────────────

app.get('/api/combined/options/:baseCoin', (req, res) => {
  try {
    const baseCoin  = req.params.baseCoin.toUpperCase()
    const response  = buildCombinedResponse(baseCoin)
    if (!response) return res.status(400).json({ error: `No data for ${baseCoin}` })
    res.json(response)
  } catch (error) {
    console.error('Error serving combined options:', error)
    res.status(500).json({ error: error.message || 'Internal server error' })
  }
});

app.get('/api/stream/polymarket/:asset', async (req, res) => {
  const asset = req.params.asset.toUpperCase()
  const spotPrice = Number(req.query.spotPrice ?? 0) || 0

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.socket?.setNoDelay(true)
  res.write('retry: 1000\n\n')

  try {
    const surface = await polymarketSurfaceBroadcaster.fetchSurface(asset, spotPrice)
    res.write(`data: ${JSON.stringify(surface)}\n\n`)
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error?.message || 'Polymarket surface unavailable' })}\n\n`)
  }

  const key = `polymarket:${asset}`
  if (!sseClients.has(key)) sseClients.set(key, new Map())
  sseClients.get(key).set(res, { spotPrice })

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 5_000)
  attachSseLease({
    req,
    res,
    leaseMs: SSE_LEASE_MS,
    onCleanup() {
      clearInterval(heartbeat)
      sseClients.get(key)?.delete(res)
    },
  })
})

// ─── SSE Stream Route ─────────────────────────────────────────────────────────

app.get('/api/stream/:exchange/:coin', (req, res) => {
  const exchange = req.params.exchange
  const coin     = req.params.coin.toUpperCase()
  const expiry   = req.query.expiry || null  // optional: filter pushes to one expiry

  if (!VALID_EXCHANGES.has(exchange)) {
    return res.status(400).json({ error: `Unknown exchange: ${exchange}` })
  }
  if (!isValidStreamCoin(exchange, coin)) {
    return res.status(400).json({ error: `Unknown coin: ${coin}` })
  }

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')  // disable nginx/proxy buffering
  res.flushHeaders()
  // Disable Nagle's algorithm so each SSE write is sent immediately
  res.socket?.setNoDelay(true)

  // Tell the browser to reconnect after 1s instead of the default 3s
  res.write('retry: 1000\n\n')

  // Send current snapshot immediately so the client has data before first push
  const snapshot = getDataForExchange(exchange, coin)
  if (snapshot) {
    const filtered = expiry ? filterByExpiry(snapshot, expiry) : snapshot
    res.write(`data: ${JSON.stringify(filtered)}\n\n`)
  }

  const key = `${exchange}:${coin}`
  if (!sseClients.has(key)) sseClients.set(key, new Map())
  sseClients.get(key).set(res, { expiry })

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 5_000)
  attachSseLease({
    req,
    res,
    leaseMs: SSE_LEASE_MS,
    onCleanup() {
      clearInterval(heartbeat)
      sseClients.get(key)?.delete(res)
    },
  })
})

// ─── Deribit Route ────────────────────────────────────────────────────────────

app.get('/api/deribit/options/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  const response = buildDeribitResponse(coin)
  if (!response) {
    return res.status(400).json({ error: `Unknown coin: ${coin}` })
  }
  res.json(response)
})

// ─── Derive Route ─────────────────────────────────────────────────────────────

app.get('/api/derive/options/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  const response = buildDeriveResponse(coin)
  if (!response) {
    return res.status(400).json({ error: `Unknown coin: ${coin}` })
  }
  res.json(response)
})

// ─── Analysis Route ───────────────────────────────────────────────────────────

app.get('/api/analysis/:exchange/:coin', (req, res) => {
  const { exchange } = req.params
  const coin = req.params.coin.toUpperCase()
  const key = `${exchange}:${coin}`
  const cached = analysisCache[key]
  if (!cached) return res.status(503).json({ error: 'Analysis cache warming up, try again shortly' })
  res.json(cached)
})

app.get('/api/polymarket/surface/:asset', polymarketSurfaceRouteHandler)
app.get('/api/polymarket/:asset/:horizon', polymarketRouteHandler)

// ─── Arbs Route ───────────────────────────────────────────────────────────────

app.get('/api/arbs/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  const cached = arbCache[coin]
  if (!cached) return res.status(503).json({ error: 'Arb cache warming up' })
  res.json(cached)
})

// ─── Scanners Route ───────────────────────────────────────────────────────────

app.get('/api/scanners/:exchange/:coin', (req, res) => {
  const { exchange } = req.params
  const coin = req.params.coin.toUpperCase()
  const exchangesParam = req.query.exchanges

  // If a filtered exchange list is requested, compute on-the-fly from the combined cache
  if (exchangesParam) {
    const activeExchanges = exchangesParam.split(',').map(e => e.trim()).filter(Boolean)
    const key = `${exchange}:${coin}`
    const cached = scannerCache[key]
    if (!cached) return res.status(503).json({ error: 'Scanner cache warming up' })
    // Re-use the cached optionsData snapshot stored alongside gamma/vega
    const { optionsData, spotPrice } = cached._raw ?? {}
    if (!optionsData) return res.status(503).json({ error: 'Scanner cache warming up' })
    return res.json({
      gamma: computeGammaRows(optionsData, spotPrice, activeExchanges),
      vega:  computeVegaRows(optionsData, spotPrice, activeExchanges),
      updatedAt: cached.updatedAt,
    })
  }

  const cached = scannerCache[`${exchange}:${coin}`]
  if (!cached) return res.status(503).json({ error: 'Scanner cache warming up' })
  res.json(cached)
})

registerOptionalRoutes(app, {
  runtimeConfig,
  okxPortfolioService,
  bybitPortfolioService,
  buildCombinedResponse,
  runOptimizer,
  futuresCache,
})

// Debug: inspect raw Derive cache to see actual field names
app.get('/api/futures/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  if (!futuresCache[coin]) return res.status(400).json({ error: `Unsupported coin: ${coin}` })
  res.json({ coin, futures: futuresCache[coin] })
})

app.get('/api/derive/debug/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  const keys = Object.keys(deriveTickersCache).filter(k => k.startsWith(`${coin}-`))
  const sample = keys.slice(0, 3).map(k => ({ instrument: k, data: deriveTickersCache[k] }))
  res.json({ totalCached: keys.length, spotCache: deriveSpotCache, sample })
})

// ─── Start OKX WebSocket + Ticker Polling ────────────────────────────────────
startOkxWebSocket();
startOkxTickerPolling();
startBybitPolling()
startDeribitPolling()
startDeribitWS()
startFuturesPolling()
startBinanceWS()
startPolymarketWS()
startDeriveFeed()

// ─── SSE Push Callbacks ───────────────────────────────────────────────────────
const emitDeribit = makeThrottledEmitter('deribit', buildDeribitResponse, 500)
const emitDerive  = makeThrottledEmitter('derive',  buildDeriveResponse,  250)

// Deribit WS fires on Greek updates — emit to deribit SSE clients
setDeribitUpdateCallback((coin) => emitDeribit(coin))

// Deribit REST polls every 5s but has no callback — push after each poll cycle
const _deribitPollInterval = setInterval(() => {
  for (const coin of ['BTC', 'ETH', 'SOL']) {
    const data = buildDeribitResponse(coin)
    if (!data) continue
    emitSSE('deribit', coin, data)
    updateAnalysisCache(`deribit:${coin}`, data, bybitSpotCache[coin] ?? 0)
    updateScannerCache(`deribit:${coin}`, data, bybitSpotCache[coin] ?? 0)

    if (hasSSEClients('combined', coin)) {
      const combinedResp = buildCombinedResponse(coin)
      if (combinedResp) {
        emitSSE('combined', coin, combinedResp)
        updateAnalysisCache(`combined:${coin}`, combinedResp, bybitSpotCache[coin] ?? 0)
        updateScannerCache(`combined:${coin}`, combinedResp, bybitSpotCache[coin] ?? 0)
        updateArbCache(coin, combinedResp, bybitSpotCache[coin] ?? 0, futuresCache[coin] ?? [])
      }
    }
  }
}, 5000)

// Derive WS fires on updates via setDeriveUpdateCallback
setDeriveUpdateCallback((coin) => emitDerive(coin))

// Binance WS fires on each 1s mark price update
setBinanceUpdateCallback((coin) => {
  const data = buildBinanceResponse(coin)
  if (data) {
    emitSSE('binance', coin, data)
    updateAnalysisCache(`binance:${coin}`, data, binanceSpotCache[coin] ?? 0)
    updateScannerCache(`binance:${coin}`, data, binanceSpotCache[coin] ?? 0)
  }
  if (hasSSEClients('combined', coin)) {
    const combined = buildCombinedResponse(coin)
    if (combined) {
      emitSSE('combined', coin, combined)
      updateAnalysisCache(`combined:${coin}`, combined, binanceSpotCache[coin] ?? 0)
      updateScannerCache(`combined:${coin}`, combined, binanceSpotCache[coin] ?? 0)
      updateArbCache(coin, combined, binanceSpotCache[coin] ?? 0, futuresCache[coin] ?? [])
    }
  }
})

setPolymarketUpdateCallback((tokenId) => {
  const assets = polymarketTokenAssetMap.get(String(tokenId))
  if (!assets?.size) return
  for (const asset of assets) {
    emitPolymarketSurface(asset)
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Bybit Options Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📈 API docs: http://localhost:${PORT}/api/options/BTC`);
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`)
  clearInterval(_deribitPollInterval)
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT',  () => gracefulShutdown('SIGINT'))
