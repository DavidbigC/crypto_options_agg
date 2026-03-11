import crypto from 'node:crypto'

const BYBIT_BASE_URL = 'https://api.bybit.com'
const RECV_WINDOW = '5000'

function parseNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseOptionDate(raw) {
  const value = String(raw || '').toUpperCase()
  const months = {
    JAN: '01',
    FEB: '02',
    MAR: '03',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AUG: '08',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DEC: '12',
  }

  const match = value.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/)
  if (!match) return null
  const [, day, month, year] = match
  const monthNumber = months[month]
  if (!monthNumber) return null
  return `20${year}-${monthNumber}-${day.padStart(2, '0')}`
}

function parseInstrument(symbol, category) {
  const normalizedCategory = String(category || '').toLowerCase()
  const upperSymbol = String(symbol || '').toUpperCase()

  if (normalizedCategory === 'option') {
    const parts = upperSymbol.split('-')
    if (parts.length >= 4) {
      return {
        coin: parts[0] || '',
        kind: 'option',
        optionType: parts[3] === 'C' ? 'call' : 'put',
        expiry: parseOptionDate(parts[1]),
        strike: parseNumber(parts[2]) || null,
      }
    }
  }

  if (normalizedCategory === 'linear' || normalizedCategory === 'inverse') {
    const coin = upperSymbol
      .replace(/USDT$/, '')
      .replace(/USDC$/, '')
      .replace(/USD$/, '')
      .replace(/PERP$/, '')
    return {
      coin,
      kind: 'future',
      optionType: null,
      expiry: 'perpetual',
      strike: null,
    }
  }

  return {
    coin: '',
    kind: 'other',
    optionType: null,
    expiry: null,
    strike: null,
  }
}

function normalizeBalances(balancePayload) {
  const account = balancePayload?.result?.list?.[0] ?? {}
  const coins = Array.isArray(account.coin) ? account.coin : []

  return coins
    .map((coin) => ({
      currency: coin.coin || '',
      equity: parseNumber(coin.equity),
      usdValue: parseNumber(coin.usdValue),
      available: parseNumber(coin.walletBalance),
      frozen: parseNumber(coin.locked),
      upl: parseNumber(coin.unrealisedPnl),
    }))
    .filter((balance) => balance.currency)
    .sort((a, b) => b.usdValue - a.usdValue)
}

function normalizePositions(positionPayloads) {
  const positions = []

  for (const payload of positionPayloads) {
    const category = payload?.result?.category || ''
    const rows = Array.isArray(payload?.result?.list) ? payload.result.list : []

    for (const position of rows) {
      const rawSize = parseNumber(position.size)
      if (rawSize === 0) continue

      const parsed = parseInstrument(position.symbol, category)
      const side = String(position.side || '').toLowerCase()
      const size = side === 'sell' ? -Math.abs(rawSize) : Math.abs(rawSize)
      const markPrice = parseNumber(position.markPrice)
      const positionMargin = parseNumber(position.positionIM)
      const referencePrice = parseNumber(position.indexPrice) || (parsed.kind === 'option' ? 0 : markPrice)

      positions.push({
        instrument: position.symbol || '',
        instrumentType: String(category || '').toUpperCase(),
        coin: parsed.coin,
        kind: parsed.kind,
        optionType: parsed.optionType,
        expiry: parsed.expiry,
        strike: parsed.strike,
        referencePrice,
        marginMode: Number(position.tradeMode) === 1 ? 'isolated' : 'cross',
        size,
        averagePrice: parseNumber(position.avgPrice),
        markPrice,
        unrealizedPnl: parseNumber(position.unrealisedPnl),
        unrealizedPnlRatio: positionMargin !== 0
          ? parseNumber(position.unrealisedPnl) / positionMargin
          : 0,
        delta: parseNumber(position.delta),
        gamma: parseNumber(position.gamma),
        theta: parseNumber(position.theta),
        vega: parseNumber(position.vega),
        notionalUsd: parsed.kind === 'option' ? 0 : Math.abs(size) * markPrice,
      })
    }
  }

  return positions.sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd))
}

function aggregateGreeks(positions) {
  const total = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  const byCoin = {}

  for (const position of positions) {
    total.delta += position.delta
    total.gamma += position.gamma
    total.theta += position.theta
    total.vega += position.vega

    if (!position.coin) continue
    if (!byCoin[position.coin]) {
      byCoin[position.coin] = { delta: 0, gamma: 0, theta: 0, vega: 0 }
    }
    byCoin[position.coin].delta += position.delta
    byCoin[position.coin].gamma += position.gamma
    byCoin[position.coin].theta += position.theta
    byCoin[position.coin].vega += position.vega
  }

  return { total, byCoin }
}

export function normalizeBybitPortfolio({
  accountPayload,
  balancePayload,
  positionPayloads,
  now = new Date().toISOString(),
}) {
  const account = accountPayload?.result ?? {}
  const wallet = balancePayload?.result?.list?.[0] ?? {}
  const balances = normalizeBalances(balancePayload)
  const positions = normalizePositions(positionPayloads)
  const greeks = aggregateGreeks(positions)

  return {
    exchange: 'bybit',
    account: {
      label: 'Bybit Unified',
      permission: 'read_only',
      positionMode: String(account.marginMode || '').toLowerCase() === 'portfolio_margin'
        ? 'merged_single'
        : 'merged_single',
      greeksType: 'BS',
      settleCurrency: 'USD',
    },
    summary: {
      totalEquityUsd: parseNumber(wallet.totalEquity),
      availableEquityUsd: parseNumber(wallet.totalAvailableBalance) || null,
      openPositions: positions.length,
      derivativesCount: positions.length,
      balancesCount: balances.length,
      updatedAt: now,
    },
    balances,
    greeks,
    positions,
  }
}

function readCredentials(env) {
  return {
    apiKey: env.BYBIT_API_KEY || '',
    secretKey: env.BYBIT_API_SECRET || '',
  }
}

function buildSignature({ secretKey, apiKey, timestamp, queryString = '' }) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(`${timestamp}${apiKey}${RECV_WINDOW}${queryString}`)
    .digest('hex')
}

function encodeQuery(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
  ).toString()
}

export function createBybitPortfolioService({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timestamp = () => String(Date.now()),
} = {}) {
  async function bybitGet(path, params = {}) {
    const credentials = readCredentials(env)
    if (!credentials.apiKey || !credentials.secretKey) {
      throw new Error('Missing Bybit credentials')
    }

    const time = timestamp()
    const queryString = encodeQuery(params)
    const url = `${BYBIT_BASE_URL}${path}${queryString ? `?${queryString}` : ''}`
    const headers = {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': credentials.apiKey,
      'X-BAPI-TIMESTAMP': time,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': buildSignature({
        secretKey: credentials.secretKey,
        apiKey: credentials.apiKey,
        timestamp: time,
        queryString,
      }),
    }

    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      throw new Error(`Bybit request failed with HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (payload?.retCode !== 0) {
      throw new Error(payload?.retMsg || `Bybit request failed with code ${payload?.retCode ?? 'unknown'}`)
    }

    return payload
  }

  return {
    async fetchPortfolio() {
      const [accountPayload, balancePayload, optionPositions, linearPositions] = await Promise.all([
        bybitGet('/v5/account/info'),
        bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
        bybitGet('/v5/position/list', { category: 'option' }),
        Promise.all([
          bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }),
          bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDC' }),
          bybitGet('/v5/position/list', { category: 'inverse' }),
        ]),
      ])

      return normalizeBybitPortfolio({
        accountPayload,
        balancePayload,
        positionPayloads: [optionPositions, ...linearPositions],
        now: now(),
      })
    },
  }
}
