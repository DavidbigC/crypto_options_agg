import { fitSVI, sviIV } from './svi.js'

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

function dateToMs(expiration) {
  return new Date(`${expiration}T08:00:00Z`).getTime()
}

function dateLabel(expiration) {
  return new Date(`${expiration}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function roundTo(value, digits = 1) {
  return Number(value.toFixed(digits))
}

function resolveBid(contract) {
  if (contract?.bestBid > 0) return contract.bestBid
  const venueBids = Object.values(contract?.prices ?? {})
    .map((price) => price?.bid ?? 0)
    .filter((value) => value > 0)
  return venueBids.length ? Math.max(...venueBids) : 0
}

function resolveAsk(contract) {
  if (contract?.bestAsk > 0) return contract.bestAsk
  const venueAsks = Object.values(contract?.prices ?? {})
    .map((price) => price?.ask ?? 0)
    .filter((value) => value > 0)
  return venueAsks.length ? Math.min(...venueAsks) : 0
}

function findClosestContract(contracts, spotPrice) {
  return contracts
    .filter((contract) => (contract?.markVol ?? 0) > 0)
    .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice))[0] ?? null
}

function makeBucketLabel(center, decimals) {
  if (Math.abs(center) < 1e-9) return 'ATM'
  const pct = (Math.exp(center) - 1) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(decimals)}%`
}

function formatUniqueBucketLabels(centers) {
  const decimals = centers.map((center) => (((Math.exp(center) - 1) * 100) >= 2 || ((Math.exp(center) - 1) * 100) <= -2 ? 0 : 1))

  for (let pass = 0; pass < 6; pass++) {
    const labels = centers.map((center, index) => makeBucketLabel(center, decimals[index]))
    const seen = new Map()
    for (const [index, label] of labels.entries()) {
      const indices = seen.get(label) ?? []
      indices.push(index)
      seen.set(label, indices)
    }
    const duplicates = Array.from(seen.entries())
      .filter(([label, indices]) => label !== 'ATM' && indices.length > 1)
      .flatMap(([, indices]) => indices)

    if (!duplicates.length) return labels
    for (const index of duplicates) {
      decimals[index] = Math.min(decimals[index] + 1, 4)
    }
  }

  return centers.map((center) => makeBucketLabel(center, 4))
}

function collectSurfaceCenters(expirations, data, spotPrice) {
  const centers = new Set()
  for (const expiration of expirations) {
    const chain = data[expiration]
    if (!chain) continue
    for (const call of chain.calls ?? []) {
      if (call.strike < spotPrice || (call.markVol ?? 0) <= 0) continue
      centers.add(Math.round(Math.log(call.strike / spotPrice) * 1e4))
    }
    for (const put of chain.puts ?? []) {
      if (put.strike > spotPrice || (put.markVol ?? 0) <= 0) continue
      centers.add(Math.round(Math.log(put.strike / spotPrice) * 1e4))
    }
  }
  return Array.from(centers).sort((a, b) => a - b).map((value) => value / 1e4)
}

function computeRawSurface(expirations, optionsData, spotPrice, nowMs) {
  const centers = collectSurfaceCenters(expirations, optionsData.data ?? {}, spotPrice)
  if (!centers.length) {
    return { expiries: [], buckets: [], cells: [] }
  }

  const labels = formatUniqueBucketLabels(centers)
  const buckets = centers.map((center, index) => ({
    key: center,
    label: labels[index],
    moneynessPct: roundTo((Math.exp(center) - 1) * 100, 1),
  }))

  const cells = []
  const expiries = []

  for (const expiration of expirations) {
    const chain = optionsData.data?.[expiration]
    if (!chain) continue

    const expiryMs = dateToMs(expiration)
    const t = Math.max((expiryMs - nowMs) / MS_PER_YEAR, 1e-4)
    const dte = Math.round(t * 365.25)
    const label = dateLabel(expiration)
    const bucketMap = new Map(
      centers.map((center) => [
        Math.round(center * 1e4),
        { ivSum: 0, count: 0, minStrike: Infinity, maxStrike: -Infinity, optionTypes: new Set() },
      ])
    )

    for (const call of chain.calls ?? []) {
      if (call.strike < spotPrice || (call.markVol ?? 0) <= 0) continue
      const k = Math.log(call.strike / spotPrice)
      const nearest = centers.reduce((closest, center) => (
        Math.abs(center - k) < Math.abs(closest - k) ? center : closest
      ), centers[0])
      const entry = bucketMap.get(Math.round(nearest * 1e4))
      if (!entry) continue
      entry.ivSum += call.markVol * 100
      entry.count += 1
      entry.minStrike = Math.min(entry.minStrike, call.strike)
      entry.maxStrike = Math.max(entry.maxStrike, call.strike)
      entry.optionTypes.add('call')
    }

    for (const put of chain.puts ?? []) {
      if (put.strike > spotPrice || (put.markVol ?? 0) <= 0) continue
      const k = Math.log(put.strike / spotPrice)
      const nearest = centers.reduce((closest, center) => (
        Math.abs(center - k) < Math.abs(closest - k) ? center : closest
      ), centers[0])
      const entry = bucketMap.get(Math.round(nearest * 1e4))
      if (!entry) continue
      entry.ivSum += put.markVol * 100
      entry.count += 1
      entry.minStrike = Math.min(entry.minStrike, put.strike)
      entry.maxStrike = Math.max(entry.maxStrike, put.strike)
      entry.optionTypes.add('put')
    }

    let cellCount = 0
    for (const [bucketKey, entry] of bucketMap.entries()) {
      if (!entry.count) continue
      cellCount += 1
      const center = bucketKey / 1e4
      const bucket = buckets.find((item) => Math.round(item.key * 1e4) === bucketKey)
      cells.push({
        exp: expiration,
        label,
        dte,
        bucketKey: center,
        bucketLabel: bucket?.label ?? '',
        moneynessPct: roundTo((Math.exp(center) - 1) * 100, 1),
        avgMarkIV: roundTo(entry.ivSum / entry.count, 1),
        count: entry.count,
        minStrike: entry.minStrike,
        maxStrike: entry.maxStrike,
        optionTypes: Array.from(entry.optionTypes).sort(),
      })
    }

    if (cellCount > 0) {
      expiries.push({ exp: expiration, label, dte })
    }
  }

  return { expiries, buckets, cells }
}

function computeAtmBboSpread(expirations, optionsData, spotPrice) {
  const rows = []
  for (const expiration of expirations) {
    const chain = optionsData.data?.[expiration]
    if (!chain) continue

    const strikes = [...new Set([...(chain.calls ?? []), ...(chain.puts ?? [])].map((contract) => contract.strike))].sort((a, b) => a - b)
    if (!strikes.length) continue

    const atmStrike = strikes.reduce((closest, strike) => (
      Math.abs(strike - spotPrice) < Math.abs(closest - spotPrice) ? strike : closest
    ), strikes[0])

    const atmCall = (chain.calls ?? []).find((contract) => contract.strike === atmStrike)
    const atmPut = (chain.puts ?? []).find((contract) => contract.strike === atmStrike)
    const spreads = [atmCall, atmPut]
      .filter(Boolean)
      .map((contract) => {
        const bid = resolveBid(contract)
        const ask = resolveAsk(contract)
        if (bid <= 0 || ask <= 0 || ask < bid) return null
        const mid = (bid + ask) / 2
        if (mid <= 0) return null
        return { usd: ask - bid, pct: ((ask - bid) / mid) * 100 }
      })
      .filter(Boolean)

    if (!spreads.length) continue

    rows.push({
      exp: expiration,
      label: dateLabel(expiration),
      spreadUsd: roundTo(spreads.reduce((sum, row) => sum + row.usd, 0) / spreads.length, 2),
      spreadPct: roundTo(spreads.reduce((sum, row) => sum + row.pct, 0) / spreads.length, 2),
    })
  }
  return rows
}

function computeSviFits(expirations, optionsData, spotPrice, nowMs) {
  const fits = {}
  for (const expiration of expirations) {
    const chain = optionsData.data?.[expiration]
    if (!chain) {
      fits[expiration] = null
      continue
    }

    const expiryMs = dateToMs(expiration)
    const t = Math.max((expiryMs - nowMs) / MS_PER_YEAR, 1e-4)
    const ks = []
    const wObs = []

    for (const call of chain.calls ?? []) {
      if (call.strike < spotPrice || (call.markVol ?? 0) <= 0) continue
      ks.push(Math.log(call.strike / spotPrice))
      wObs.push(call.markVol * call.markVol * t)
    }
    for (const put of chain.puts ?? []) {
      if (put.strike > spotPrice || (put.markVol ?? 0) <= 0) continue
      ks.push(Math.log(put.strike / spotPrice))
      wObs.push(put.markVol * put.markVol * t)
    }

    fits[expiration] = fitSVI(ks, wObs)
  }
  return fits
}

export function deriveCombinedAnalysis(optionsData, spotPrice, nowMs = Date.now()) {
  const effectiveSpot = spotPrice || optionsData?.spotPrice || 0
  const expirations = (optionsData?.expirations ?? []).filter((expiration) => dateToMs(expiration) > nowMs)
  if (!effectiveSpot || !expirations.length || !optionsData?.data) return null

  const sviFits = computeSviFits(expirations, optionsData, effectiveSpot, nowMs)
  const termStructure = []
  const skewData = []

  for (const expiration of expirations) {
    const chain = optionsData.data?.[expiration]
    if (!chain) continue

    const expiryMs = dateToMs(expiration)
    const t = Math.max((expiryMs - nowMs) / MS_PER_YEAR, 1e-4)
    const dte = Math.round(t * 365.25)
    const label = dateLabel(expiration)
    const fit = sviFits[expiration]

    let atmIV = null
    if (fit) {
      atmIV = roundTo(sviIV(0, t, fit.params) * 100, 1)
    } else {
      const atmContract = findClosestContract([...(chain.calls ?? []), ...(chain.puts ?? [])], effectiveSpot)
      if (atmContract?.markVol) {
        atmIV = roundTo(atmContract.markVol * 100, 1)
      }
    }

    if (atmIV !== null) {
      termStructure.push({ label, dte, atmIV, exp: expiration })
    }

    const call25 = (chain.calls ?? [])
      .filter((contract) => contract.delta >= 0.05 && contract.delta <= 0.5)
      .sort((a, b) => Math.abs(a.delta - 0.25) - Math.abs(b.delta - 0.25))[0] ?? null
    const put25 = (chain.puts ?? [])
      .filter((contract) => contract.delta <= -0.05 && contract.delta >= -0.5)
      .sort((a, b) => Math.abs(a.delta + 0.25) - Math.abs(b.delta + 0.25))[0] ?? null
    const atmCall = findClosestContract(chain.calls ?? [], effectiveSpot)

    if (call25?.markVol && put25?.markVol && atmCall?.markVol) {
      skewData.push({
        label,
        rr: roundTo((call25.markVol - put25.markVol) * 100, 2),
        bf: roundTo((((call25.markVol + put25.markVol) / 2) - atmCall.markVol) * 100, 2),
        exp: expiration,
      })
    }
  }

  return {
    sviFits,
    termStructure,
    skewData,
    rawSurface: computeRawSurface(expirations, optionsData, effectiveSpot, nowMs),
    atmBboSpread: computeAtmBboSpread(expirations, optionsData, effectiveSpot),
    updatedAt: nowMs,
  }
}
