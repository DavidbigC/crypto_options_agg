const VALID_COINS = new Set(['BTC', 'ETH', 'SOL'])
const VALID_OKX_FAMILIES = new Set(['BTC-USD', 'ETH-USD', 'SOL-USD'])

export function isValidStreamCoin(exchange, coin) {
  if (exchange === 'okx') return VALID_OKX_FAMILIES.has(coin)
  return VALID_COINS.has(coin)
}
