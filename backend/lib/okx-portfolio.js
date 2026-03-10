import crypto from 'node:crypto'

const OKX_BASE_URL = 'https://www.okx.com'

function parseNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function firstRow(payload) {
  return Array.isArray(payload?.data) ? (payload.data[0] ?? {}) : {}
}

function parseInstrument(instId, instType) {
  const parts = String(instId || '').split('-')
  const coin = parts[0] || ''
  const kind = String(instType || '').toUpperCase()

  if (kind === 'OPTION' && parts.length >= 5) {
    const rawExpiry = parts[2]
    return {
      coin,
      kind: 'option',
      optionType: parts[4] === 'C' ? 'call' : 'put',
      expiry: `20${rawExpiry.slice(0, 2)}-${rawExpiry.slice(2, 4)}-${rawExpiry.slice(4, 6)}`,
      strike: parseNumber(parts[3]) || null,
    }
  }

  if (kind === 'SWAP') {
    return {
      coin,
      kind: 'swap',
      optionType: null,
      expiry: 'perpetual',
      strike: null,
    }
  }

  if (kind === 'FUTURES' && parts.length >= 3) {
    const rawExpiry = parts[2]
    return {
      coin,
      kind: 'future',
      optionType: null,
      expiry: `20${rawExpiry.slice(0, 2)}-${rawExpiry.slice(2, 4)}-${rawExpiry.slice(4, 6)}`,
      strike: null,
    }
  }

  return {
    coin,
    kind: 'other',
    optionType: null,
    expiry: null,
    strike: null,
  }
}

function readCredentials(env) {
  const apiKey = env.OKX_API_KEY || env.apikey || ''
  const secretKey = env.OKX_SECRET_KEY || env.secretkey || ''
  const passphrase = env.OKX_PASSPHRASE || env.passphrase || ''
  const demoTrading = String(env.OKX_DEMO_TRADING || '').toLowerCase() === 'true'

  return {
    apiKey,
    secretKey,
    passphrase,
    demoTrading,
  }
}

function signRequest({ secretKey, timestamp, method, path, body = '' }) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(`${timestamp}${method}${path}${body}`)
    .digest('base64')
}

function makeTimestamp() {
  return new Date().toISOString()
}

function normalizeBalances(balancePayload) {
  const details = Array.isArray(firstRow(balancePayload).details)
    ? firstRow(balancePayload).details
    : []

  return details
    .map((detail) => ({
      currency: detail.ccy || '',
      equity: parseNumber(detail.eq),
      usdValue: parseNumber(detail.eqUsd),
      available: parseNumber(detail.availBal),
      frozen: parseNumber(detail.frozenBal),
      upl: parseNumber(detail.upl),
    }))
    .filter((balance) => balance.currency)
    .sort((a, b) => b.usdValue - a.usdValue)
}

function normalizePositions(positionsPayload) {
  const rows = Array.isArray(positionsPayload?.data) ? positionsPayload.data : []

  return rows
    .filter((position) => parseNumber(position.pos) !== 0)
    .map((position) => {
      const parsed = parseInstrument(position.instId, position.instType)
      return {
        instrument: position.instId || '',
        instrumentType: position.instType || '',
        coin: parsed.coin,
        kind: parsed.kind,
        optionType: parsed.optionType,
        expiry: parsed.expiry,
        strike: parsed.strike,
        referencePrice: parseNumber(position.idxPx),
        marginMode: position.mgnMode || '',
        size: parseNumber(position.pos),
        averagePrice: parseNumber(position.avgPx),
        markPrice: parseNumber(position.markPx),
        unrealizedPnl: parseNumber(position.upl),
        unrealizedPnlRatio: parseNumber(position.uplRatio),
        delta: parseNumber(position.deltaBS),
        gamma: parseNumber(position.gammaBS),
        theta: parseNumber(position.thetaBS),
        vega: parseNumber(position.vegaBS),
        notionalUsd: parseNumber(position.notionalUsd),
      }
    })
    .sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd))
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

export function normalizeOkxPortfolio({
  configPayload,
  balancePayload,
  positionsPayload,
  now = new Date().toISOString(),
}) {
  const config = firstRow(configPayload)
  const balance = firstRow(balancePayload)
  const balances = normalizeBalances(balancePayload)
  const positions = normalizePositions(positionsPayload)
  const greeks = aggregateGreeks(positions)

  return {
    exchange: 'okx',
    account: {
      label: config.label || '',
      permission: config.perm || '',
      positionMode: config.posMode || '',
      greeksType: config.greeksType || '',
      settleCurrency: config.settleCcy || '',
    },
    summary: {
      totalEquityUsd: parseNumber(balance.totalEq),
      availableEquityUsd: parseNumber(balance.availEq) || null,
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

export function createOkxPortfolioService({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  async function okxGet(path) {
    const credentials = readCredentials(env)
    if (!credentials.apiKey || !credentials.secretKey || !credentials.passphrase) {
      throw new Error('Missing OKX credentials')
    }

    const timestamp = makeTimestamp()
    const headers = {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': credentials.apiKey,
      'OK-ACCESS-SIGN': signRequest({
        secretKey: credentials.secretKey,
        timestamp,
        method: 'GET',
        path,
      }),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': credentials.passphrase,
    }

    if (credentials.demoTrading) {
      headers['x-simulated-trading'] = '1'
    }

    const response = await fetchImpl(`${OKX_BASE_URL}${path}`, {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      throw new Error(`OKX request failed with HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (payload?.code !== '0') {
      throw new Error(payload?.msg || `OKX request failed with code ${payload?.code || 'unknown'}`)
    }

    return payload
  }

  return {
    async fetchPortfolio() {
      const [configPayload, balancePayload, positionsPayload] = await Promise.all([
        okxGet('/api/v5/account/config'),
        okxGet('/api/v5/account/balance'),
        okxGet('/api/v5/account/positions'),
      ])

      return normalizeOkxPortfolio({
        configPayload,
        balancePayload,
        positionsPayload,
        now: now(),
      })
    },
  }
}
