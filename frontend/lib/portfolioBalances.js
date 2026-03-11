const VISIBLE_BALANCE_CURRENCIES = new Set(['BTC', 'ETH', 'USDT'])
const MIN_VISIBLE_USD_VALUE = 1

export function filterVisibleBalances(balances) {
  return balances.filter((balance) => (
    VISIBLE_BALANCE_CURRENCIES.has(balance.currency) &&
    Math.abs(Number(balance.usdValue) || 0) >= MIN_VISIBLE_USD_VALUE
  ))
}
