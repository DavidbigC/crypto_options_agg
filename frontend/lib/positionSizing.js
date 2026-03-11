import { CONTRACT_SIZES } from '../types/options.ts'

export function normalizeImportedPositionSize({ exchange, coin, kind, size }) {
  const absoluteSize = Math.abs(Number(size) || 0)
  if (kind !== 'option') {
    return { qty: absoluteSize, contractSize: 1 }
  }

  if (exchange !== 'okx') {
    return { qty: absoluteSize, contractSize: 1 }
  }

  const multiplier = CONTRACT_SIZES[exchange]?.[coin] ?? 1
  return {
    qty: absoluteSize * multiplier,
    contractSize: 1,
  }
}
