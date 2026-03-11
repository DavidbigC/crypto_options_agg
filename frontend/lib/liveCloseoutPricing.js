export function resolveCloseoutPrice({ leg, contract, fallbackPrice = 0 }) {
  if (leg?.type === 'future') return fallbackPrice

  if (contract) {
    const combinedPrices = contract.prices?.[leg?.exchange]
    const bookPrice = leg?.side === 'buy'
      ? Number(combinedPrices?.bid ?? contract.bestBid ?? contract.bid) || 0
      : Number(combinedPrices?.ask ?? contract.bestAsk ?? contract.ask) || 0

    if (bookPrice > 0) return bookPrice

    const markPrice = Number(contract.markPrice) || 0
    if (markPrice > 0) return markPrice
  }

  return Number(fallbackPrice) || 0
}
