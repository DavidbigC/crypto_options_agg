export type PolysisDistributionBin = {
  low: number
  high: number | null
  probability: number
}

export type PolysisDistribution = {
  source: 'range' | 'threshold' | 'none'
  bins: PolysisDistributionBin[]
}

export type PolysisSummary = {
  expectedPrice: number | null
  expectedMove: number | null
  expectedMovePct: number | null
  mostLikelyRange: PolysisDistributionBin | null
}

export type PolysisConfidence = {
  score: number
  label: 'low' | 'medium' | 'high'
  marketCount?: number
  totalVolume?: number
  totalOpenInterest?: number
}

export type PolysisPathSummary = {
  pathMovePct: number | null
  pathMoveUsd: number | null
  upsidePathPct: number | null
  downsidePathPct: number | null
  strongestUpsideBarrier: number | null
  strongestDownsideBarrier: number | null
}

export type PolysisSourceMarket = {
  id: string
  slug?: string | null
  question: string
  endDate?: string | null
  tokenId?: string | null
  lastTradePrice?: number
  volumeNum?: number
  openInterest?: number
  spreadPct?: number
  classification?: {
    type: 'range' | 'threshold' | 'path' | 'unknown'
    confidence?: 'low' | 'high'
    direction?: 'above' | 'below'
    strike?: number
    barrier?: number
    range?: { low: number; high: number }
    reason?: string
  }
}

export type PolysisResponse = {
  asset: 'BTC' | 'ETH' | 'SOL'
  horizon: 'daily' | 'weekly' | 'monthly' | 'yearly'
  expiryDate?: string | null
  distribution: PolysisDistribution
  summary: PolysisSummary
  pathSummary: PolysisPathSummary | null
  confidence: PolysisConfidence | null
  repricing: {
    change24h: number | null
    change7d: number | null
  }
  sourceMarkets: PolysisSourceMarket[]
  pathMarkets?: PolysisSourceMarket[]
}

export type PolysisSurfaceResponse = {
  asset: 'BTC' | 'ETH' | 'SOL'
  generatedAt?: string
  horizons: Partial<Record<'daily' | 'weekly' | 'monthly' | 'yearly', PolysisResponse | null>>
}
