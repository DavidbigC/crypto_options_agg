#!/usr/bin/env node
/**
 * Node.js/Express backend API to serve options data from Bybit
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { BybitOptionsAPI } from './lib/bybit-api-axios.js';
import { bybitWsTickerCache, bybitWsSpotCache, startBybitWS, setBybitWsUpdateCallback } from './lib/bybit-ws.js'
import { mockSpotPrices, getMockOptionsData } from './lib/mock-data.js';
import {
  calculateTimeToExpiration,
  groupOptionsByStrike,
  findATMStrike,
  sanitizeOptionData
} from './lib/utils.js';
import { okxCache, startOkxWebSocket } from './lib/okx-ws.js'
import { startDeribitPolling, buildDeribitResponse } from './lib/deribit.js';
import { startDeribitWS, setDeribitUpdateCallback } from './lib/deribit-ws.js';
import { buildDeriveResponse } from './lib/derive.js';
import { addDeriveViewer, removeDeriveViewer, deriveTickersCache, deriveSpotCache, setDeriveUpdateCallback } from './lib/derive-ws.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3500;

// Middleware
app.use(cors());
app.use(express.json());

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
    if (!optionsByDate[expiry]) optionsByDate[expiry] = { calls: [], puts: [] }
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
  const okxFamily         = `${baseCoin}-USD`
  const bybitTickers      = Object.values(bybitTickerCache[baseCoin] ?? {})
  const bybitSpot         = bybitSpotCache[baseCoin] ?? 0
  const okxFamilyCache    = okxCache[okxFamily] ?? {}
  const okxFamilyTickers  = okxTickerCache[okxFamily] ?? {}
  const okxSpot           = okxSpotCache[`${baseCoin}-USDT`] ?? 0
  const spotPrice         = bybitSpot || okxSpot
  const merged = {}
  const ensure = (key) => {
    if (!merged[key]) merged[key] = { bestBid: 0, bestBidEx: null, bestAsk: 0, bestAskEx: null, delta: 0, gamma: 0, theta: 0, vega: 0 }
    return merged[key]
  }
  for (const ticker of bybitTickers) {
    const parsed = bybitApi.parseOptionSymbol(ticker.symbol)
    if (!parsed) continue
    const key   = `${parsed.expiryDate}|${parsed.strikePrice}|${parsed.optionType.toLowerCase()}`
    const entry = ensure(key)
    const bid   = parseFloat(ticker.bid1Price || 0)
    const ask   = parseFloat(ticker.ask1Price || 0)
    if (bid > entry.bestBid) { entry.bestBid = bid; entry.bestBidEx = 'bybit' }
    if (ask > 0 && (entry.bestAsk === 0 || ask < entry.bestAsk)) { entry.bestAsk = ask; entry.bestAskEx = 'bybit' }
    entry.delta = parseFloat(ticker.delta || 0)
    entry.gamma = parseFloat(ticker.gamma || 0)
    entry.theta = parseFloat(ticker.theta || 0)
    entry.vega  = parseFloat(ticker.vega || 0)
  }
  for (const [instId, item] of Object.entries(okxFamilyCache)) {
    const parsed = parseOkxInstId(instId)
    if (!parsed) continue
    const key    = `${parsed.expiryDate}|${parsed.strikePrice}|${parsed.optionType}`
    const entry  = ensure(key)
    const ticker = okxFamilyTickers[instId] ?? {}
    const bid    = parseFloat(ticker.bidPx || 0) * (okxSpot || 1)
    const ask    = parseFloat(ticker.askPx || 0) * (okxSpot || 1)
    if (bid > entry.bestBid) { entry.bestBid = bid; entry.bestBidEx = 'okx' }
    if (ask > 0 && (entry.bestAsk === 0 || ask < entry.bestAsk)) { entry.bestAsk = ask; entry.bestAskEx = 'okx' }
    const delta = parseFloat(item.delta || 0)
    if (delta !== 0) {
      entry.delta = delta
      entry.gamma = okxSpot > 0 ? parseFloat(item.gamma || 0) / okxSpot : 0
      entry.theta = parseFloat(item.theta || 0) * okxSpot
      entry.vega  = parseFloat(item.vega || 0) * okxSpot
    }
  }
  const deribitResp = buildDeribitResponse(baseCoin)
  if (deribitResp) {
    for (const [expiryDate, dateData] of Object.entries(deribitResp.data)) {
      for (const contract of [...dateData.calls, ...dateData.puts]) {
        const key   = `${expiryDate}|${contract.strike}|${contract.optionType}`
        const entry = ensure(key)
        if (contract.bid > entry.bestBid) { entry.bestBid = contract.bid; entry.bestBidEx = 'deribit' }
        if (contract.ask > 0 && (entry.bestAsk === 0 || contract.ask < entry.bestAsk)) { entry.bestAsk = contract.ask; entry.bestAskEx = 'deribit' }
        if (contract.delta !== 0) {
          entry.delta = contract.delta
          entry.gamma = contract.gamma
          entry.theta = contract.theta
          entry.vega  = contract.vega
        }
      }
    }
  }
  const optionsByDate = {}
  for (const [key, entry] of Object.entries(merged)) {
    const [expiryDate, strikeStr, optionType] = key.split('|')
    const contract = { strike: parseFloat(strikeStr), optionType, ...entry }
    if (!optionsByDate[expiryDate]) optionsByDate[expiryDate] = { calls: [], puts: [] }
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

// ─── SSE Infrastructure ───────────────────────────────────────────────────────

const sseClients = new Map() // key: 'exchange:coin' → Set<ServerResponse>

function emitSSE(exchange, coin, data) {
  const key     = `${exchange}:${coin}`
  const clients = sseClients.get(key)
  if (!clients?.size) return
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
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

// ─── Bybit Background Cache ───────────────────────────────────────────────────
const bybitTickerCache = bybitWsTickerCache
const bybitSpotCache   = bybitWsSpotCache

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
    emitSSE('okx',      instFamily, buildOkxResponse(instFamily))
    emitSSE('combined', coin,       buildCombinedResponse(coin))
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

// ─── SSE Stream Route ─────────────────────────────────────────────────────────

app.get('/api/stream/:exchange/:coin', (req, res) => {
  const exchange = req.params.exchange
  const coin     = req.params.coin.toUpperCase()

  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')  // disable nginx/proxy buffering
  res.flushHeaders()

  // Tell the browser to reconnect after 1s instead of the default 3s
  res.write('retry: 1000\n\n')

  // Send current snapshot immediately so the client has data before first push
  const snapshot = getDataForExchange(exchange, coin)
  if (snapshot) res.write(`data: ${JSON.stringify(snapshot)}\n\n`)

  const key = `${exchange}:${coin}`
  if (!sseClients.has(key)) sseClients.set(key, new Set())
  sseClients.get(key).add(res)

  // if (exchange === 'derive') addDeriveViewer(coin)  // DISABLED for perf testing

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 5_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    sseClients.get(key)?.delete(res)
    // if (exchange === 'derive') removeDeriveViewer(coin)  // DISABLED for perf testing
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

// Debug: inspect raw Derive cache to see actual field names
app.get('/api/derive/debug/:coin', (req, res) => {
  const coin = req.params.coin.toUpperCase()
  const keys = Object.keys(deriveTickersCache).filter(k => k.startsWith(`${coin}-`))
  const sample = keys.slice(0, 3).map(k => ({ instrument: k, data: deriveTickersCache[k] }))
  res.json({ totalCached: keys.length, spotCache: deriveSpotCache, sample })
})

// ─── Start OKX WebSocket + Ticker Polling ────────────────────────────────────
startOkxWebSocket();
startOkxTickerPolling();
startBybitWS()
// startDeribitPolling();  // DISABLED for perf testing
// startDeribitWS();       // DISABLED for perf testing
// Derive WS is demand-driven — started by addDeriveViewer() when first SSE client connects

// ─── SSE Push Callbacks ───────────────────────────────────────────────────────
// const emitDerive  = makeThrottledEmitter('derive',  buildDeriveResponse,   250)  // DISABLED for perf testing
// const emitDeribit = makeThrottledEmitter('deribit', buildDeribitResponse,  500)  // DISABLED for perf testing
const emitCombinedDebounced = makeThrottledEmitter('combined', buildCombinedResponse, 500)

// setDeriveUpdateCallback((currency) => {  // DISABLED for perf testing
//   emitDerive(currency)
//   emitCombinedDebounced(currency)
// })

// setDeribitUpdateCallback((currency) => {  // DISABLED for perf testing
//   emitDeribit(currency)
//   emitCombinedDebounced(currency)
// })

const emitBybit = makeThrottledEmitter('bybit', buildBybitResponse, 100)

setBybitWsUpdateCallback((coin) => {
  emitBybit(coin)
  emitCombinedDebounced(coin)
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
app.listen(PORT, () => {
  console.log(`🚀 Bybit Options Backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📈 API docs: http://localhost:${PORT}/api/options/BTC`);
});