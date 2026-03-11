function isImportedExchangeLeg(leg, exchange) {
  return leg.exchange === exchange && leg.source === 'portfolio-import'
}

export function mergeImportedExchangeLegs(existingLegs, importedLegs, exchange) {
  const preserved = existingLegs.filter((leg) => !isImportedExchangeLeg(leg, exchange))
  return [...preserved, ...importedLegs]
}

export function clearImportedExchangeLegs(existingLegs, exchange) {
  return existingLegs.filter((leg) => !isImportedExchangeLeg(leg, exchange))
}
