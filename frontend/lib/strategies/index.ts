export type { ArbLeg, ArbStrategy, ArbOpportunity } from './types'
export type { BoxLeg, BoxSpread } from './boxSpread'

export { findBoxSpreads } from './boxSpread'
export { findVerticalArbs } from './vertical'
export { findButterflyArbs } from './butterfly'
export { findCalendarArbs } from './calendar'
export { findPCPArbs } from './pcp'

import { OptionsData } from '@/types/options'
import { ArbOpportunity, FutureData } from './types'
import { findVerticalArbs } from './vertical'
import { findButterflyArbs } from './butterfly'
import { findCalendarArbs } from './calendar'
import { findPCPArbs } from './pcp'

export type { FutureData }

export function findAllArbs(
  optionsData: OptionsData,
  spotPrice: number,
  activeExchanges: Set<string>,
  futures: FutureData[] = [],
): ArbOpportunity[] {
  return [
    ...findVerticalArbs(optionsData, spotPrice, activeExchanges),
    ...findButterflyArbs(optionsData, spotPrice, activeExchanges),
    ...findCalendarArbs(optionsData, spotPrice, activeExchanges),
    ...findPCPArbs(optionsData, spotPrice, activeExchanges, futures),
  ]
}
