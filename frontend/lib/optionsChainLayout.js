export function collectSortedStrikes(data) {
  const allStrikes = new Set()

  for (const contract of data?.calls ?? []) {
    if (typeof contract?.strike === 'number') allStrikes.add(contract.strike)
  }

  for (const contract of data?.puts ?? []) {
    if (typeof contract?.strike === 'number') allStrikes.add(contract.strike)
  }

  return Array.from(allStrikes).sort((a, b) => a - b)
}

export function findAtmStrike(strikes, spotPrice) {
  if (!Array.isArray(strikes) || strikes.length === 0) return null

  return strikes.reduce((prev, curr) =>
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  )
}

export function getStrikeBand({ strike, spotPrice, atmStrike }) {
  if (atmStrike === null || strike === atmStrike) return 'atm'
  return strike < spotPrice ? 'itm' : 'otm'
}

export function getOptionMoneyness({ optionType, strike, spotPrice, atmStrike }) {
  if (atmStrike !== null && strike === atmStrike) return 'atm'

  if (optionType === 'call') {
    return strike < spotPrice ? 'itm' : 'otm'
  }

  return strike > spotPrice ? 'itm' : 'otm'
}
