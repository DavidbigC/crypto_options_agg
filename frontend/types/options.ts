export type Exchange = 'bybit' | 'okx' | 'combined' | 'deribit' | 'derive'

export interface CombinedOptionContract {
  strike: number
  optionType: 'call' | 'put'
  bestBid: number
  bestBidEx: 'bybit' | 'okx' | 'deribit' | null
  bestAsk: number
  bestAskEx: 'bybit' | 'okx' | 'deribit' | null
  delta: number
  gamma: number
  theta: number
  vega: number
}

export interface CombinedOptionsChainData {
  calls: CombinedOptionContract[]
  puts: CombinedOptionContract[]
}

export interface OptionContract {
  symbol: string
  strike: number
  optionType: 'call' | 'put'
  bid: number
  ask: number
  last: number
  volume: number
  bidSize: number
  askSize: number
  delta: number
  gamma: number
  theta: number
  vega: number
  impliedVolatility: number
  openInterest: number
  markPrice: number
  // OKX-specific implied volatility fields
  markVol?: number
  bidVol?: number
  askVol?: number
}

export interface OptionsChainData {
  calls: OptionContract[]
  puts: OptionContract[]
  forwardPrice?: number  // per-expiry forward/futures price (Bybit only)
}

export interface OptionsData {
  spotPrice: number
  expirations: string[]
  expirationCounts: Record<string, { calls: number; puts: number }>
  data: Record<string, OptionsChainData>
}

export interface Strategy {
  name: string
  legs: StrategyLeg[]
  netPremium: number
  maxProfit: number
  maxLoss: number
  breakevens: number[]
}

export interface StrategyLeg {
  contract: OptionContract
  quantity: number
  action: 'buy' | 'sell'
}

export const CONTRACT_SIZES: Record<string, Record<string, number>> = {
  bybit:   { BTC: 1, ETH: 1, SOL: 1 },
  okx:     { BTC: 0.1, ETH: 1, SOL: 1 },
  combined:{ BTC: 1, ETH: 1, SOL: 1 },
  deribit: { BTC: 1, ETH: 1, SOL: 1 },
  derive:  { BTC: 1, ETH: 1, SOL: 1 },
}

export interface Leg {
  id: string
  exchange: Exchange
  coin: string             // 'BTC' | 'ETH' | 'SOL'
  symbol: string
  expiry: string           // 'YYYY-MM-DD'
  strike: number
  type: 'call' | 'put'
  side: 'buy' | 'sell'
  qty: number
  entryPrice: number       // USD
  markVol: number          // IV decimal e.g. 0.54
  contractSize: number
  enabled: boolean
}