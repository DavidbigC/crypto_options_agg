// frontend/types/optimizer.ts

export type GreekTarget = 'long' | 'short' | 'neutral' | 'ignore'

export interface OptimizerTargets {
  delta: GreekTarget
  gamma: GreekTarget
  vega:  GreekTarget
  theta: GreekTarget
}

export interface OptimizerLeg {
  side:     'buy' | 'sell'
  type:     'call' | 'put' | 'future'
  strike:   number
  expiry:   string
  qty:      number
  price:    number
  exchange: string | null
}

export interface OptimizerNetGreeks {
  delta: number
  gamma: number
  theta: number
  vega:  number
}

export interface OptimizerResult {
  name:             string
  legs:             OptimizerLeg[]
  netGreeks:        OptimizerNetGreeks
  totalCost:        number
  score:            number
  rebalancingNote:  string
}

export interface OptimizerRequest {
  targets:  OptimizerTargets
  maxCost:  number
  maxLegs:  number
}
