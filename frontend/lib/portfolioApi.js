export function requirePortfolioPayload(payload, exchangeLabel) {
  if (payload?.error) {
    throw new Error(payload.error || `Failed to load ${exchangeLabel} portfolio`)
  }

  return payload
}
