import {
  CLOB_BASE_URL,
  DATA_BASE_URL,
  DEFAULT_HEADERS,
  GAMMA_BASE_URL,
} from './constants.js'

function buildQuery(params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

async function readJson(response) {
  return response.json().catch(() => ({}))
}

async function requestJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: DEFAULT_HEADERS,
  })

  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}`)
  }

  return readJson(response)
}

export function assertGammaMarketsResponse(payload) {
  if (!Array.isArray(payload)) {
    throw new Error('Expected Gamma markets response to be an array')
  }
  return payload
}

function assertObject(payload, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Expected ${label} response to be an object`)
  }
  return payload
}

function assertArray(payload, label) {
  if (!Array.isArray(payload)) {
    throw new Error(`Expected ${label} response to be an array`)
  }
  return payload
}

export function createPolymarketClient({ fetchImpl = fetch } = {}) {
  return {
    async getGammaMarkets({
      limit,
      closed,
      tagId,
      endDateMin,
      endDateMax,
      slug,
    } = {}) {
      const payload = await requestJson(
        fetchImpl,
        `${GAMMA_BASE_URL}/markets${buildQuery({
          limit,
          closed,
          tag_id: tagId,
          end_date_min: endDateMin,
          end_date_max: endDateMax,
          slug,
        })}`,
        'Gamma',
      )

      return assertGammaMarketsResponse(payload)
    },

    async getClobPrices(tokenIds = []) {
      const payload = await requestJson(
        fetchImpl,
        `${CLOB_BASE_URL}/prices${buildQuery({ token_ids: tokenIds.join(',') })}`,
        'CLOB',
      )

      return assertObject(payload, 'CLOB prices')
    },

    async getOpenInterest(market) {
      const payload = await requestJson(
        fetchImpl,
        `${DATA_BASE_URL}/oi${buildQuery({ market })}`,
        'Data API',
      )

      return assertArray(payload, 'open interest')
    },
  }
}
