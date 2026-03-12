const ASSET_PATTERNS = [
  { symbol: 'BTC', pattern: /\b(?:btc|bitcoin)\b/i },
  { symbol: 'ETH', pattern: /\b(?:eth|ethereum)\b/i },
  { symbol: 'SOL', pattern: /\b(?:sol|solana)\b/i },
]

const HORIZON_PATTERNS = [
  { horizon: 'daily', pattern: /\b(?:today|daily|tomorrow)\b/i },
  { horizon: 'weekly', pattern: /\b(?:this week|weekly|week)\b/i },
  { horizon: 'monthly', pattern: /\b(?:this month|monthly|month)\b/i },
  { horizon: 'yearly', pattern: /\b(?:this year|yearly|year)\b/i },
]

function parseDollarNumber(rawValue) {
  if (!rawValue) return null
  const normalized = rawValue.replace(/[$,\s]/g, '')
  const multiplier = normalized.toLowerCase().endsWith('k') ? 1_000 : 1
  const numeric = Number.parseFloat(normalized.replace(/k$/i, ''))
  if (!Number.isFinite(numeric)) return null
  return numeric * multiplier
}

export function extractPolymarketAsset(text = '') {
  for (const { symbol, pattern } of ASSET_PATTERNS) {
    if (pattern.test(text)) return symbol
  }
  return null
}

export function extractPolymarketHorizon(text = '') {
  for (const { horizon, pattern } of HORIZON_PATTERNS) {
    if (pattern.test(text)) return horizon
  }
  return null
}

export function classifyPolymarketMarket(market = {}) {
  const question = String(market.question ?? market.title ?? '').trim()
  if (!question) {
    return { type: 'unknown', confidence: 'low', reason: 'Missing market question' }
  }

  const rangeMatch = question.match(/\$?\s*([\d,.]+k?)\s*-\s*\$?\s*([\d,.]+k?)/i)
  if (rangeMatch && /\b(?:where will|close)\b/i.test(question)) {
    const low = parseDollarNumber(rangeMatch[1])
    const high = parseDollarNumber(rangeMatch[2])
    if (low !== null && high !== null && high > low) {
      return {
        type: 'range',
        range: { low, high },
        confidence: 'high',
      }
    }
  }

  const pathMatch = question.match(/\b(?:hit|touch)\s+\$?\s*([\d,.]+k?)/i)
  if (pathMatch) {
    const barrier = parseDollarNumber(pathMatch[1])
    if (barrier !== null) {
      return {
        type: 'path',
        barrier,
        confidence: 'high',
      }
    }
  }

  const thresholdMatch = question.match(/\b(?:above|over|below|under)\s+\$?\s*([\d,.]+k?)/i)
  if (thresholdMatch) {
    const strike = parseDollarNumber(thresholdMatch[1])
    if (strike !== null) {
      return {
        type: 'threshold',
        direction: /\b(?:above|over)\b/i.test(question) ? 'above' : 'below',
        strike,
        confidence: 'high',
      }
    }
  }

  return {
    type: 'unknown',
    confidence: 'low',
    reason: 'Ambiguous market title',
  }
}
