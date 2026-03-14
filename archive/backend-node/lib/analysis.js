import { fitSVI, sviIV } from './svi.js'

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

// Derive bucket centers from the actual strikes in the data so that each
// unique strike gets its own column (≈1 contract per cell naturally).
function makeStrikeDerivedBucketCenters(expirations, response, spotPrice) {
  const kSet = new Set()
  for (const exp of expirations) {
    const chain = response.data[exp]
    if (!chain) continue
    for (const c of chain.calls ?? []) {
      if (c.strike < spotPrice || !(c.markVol > 0)) continue
      kSet.add(Number(Math.log(c.strike / spotPrice).toFixed(4)))
    }
    for (const p of chain.puts ?? []) {
      if (p.strike > spotPrice || !(p.markVol > 0)) continue
      kSet.add(Number(Math.log(p.strike / spotPrice).toFixed(4)))
    }
  }
  return Array.from(kSet).sort((a, b) => a - b)
}

export const analysisCache = {}

function formatBucketLabel(bucketCenter, decimals) {
  const pct = (Math.exp(bucketCenter) - 1) * 100
  if (Math.abs(bucketCenter) < 1e-9) return 'ATM'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(decimals)}%`
}

function formatUniqueBucketLabels(bucketCenters) {
  const decimalsByCenter = new Map(
    bucketCenters.map(center => [center, Math.abs((Math.exp(center) - 1) * 100) >= 2 ? 0 : 1])
  )

  for (let pass = 0; pass < 6; pass++) {
    const labels = bucketCenters.map(center => formatBucketLabel(center, decimalsByCenter.get(center) ?? 1))
    const collisions = new Map()
    labels.forEach((label, index) => {
      if (!collisions.has(label)) collisions.set(label, [])
      collisions.get(label).push(bucketCenters[index])
    })

    const duplicates = Array.from(collisions.entries())
      .filter(([label, centers]) => label !== 'ATM' && centers.length > 1)
      .flatMap(([, centers]) => centers)

    if (!duplicates.length) return labels

    duplicates.forEach(center => {
      decimalsByCenter.set(center, Math.min(4, (decimalsByCenter.get(center) ?? 1) + 1))
    })
  }

  return bucketCenters.map(center => formatBucketLabel(center, 4))
}

function resolveBid(contract) {
  const b = Number(contract?.bid) || 0
  if (b > 0) return b
  const best = Number(contract?.bestBid) || 0
  if (best > 0) return best
  const bids = Object.values(contract?.prices ?? {}).map(p => Number(p?.bid) || 0).filter(v => v > 0)
  return bids.length ? Math.max(...bids) : 0
}

function resolveAsk(contract) {
  const a = Number(contract?.ask) || 0
  if (a > 0) return a
  const best = Number(contract?.bestAsk) || 0
  if (best > 0) return best
  const asks = Object.values(contract?.prices ?? {}).map(p => Number(p?.ask) || 0).filter(v => v > 0)
  return asks.length ? Math.min(...asks) : 0
}

function computeAtmBboSpread(expirations, response, spotPrice) {
  const results = []
  for (const exp of expirations) {
    const chain = response.data[exp]
    if (!chain) continue

    const strikes = Array.from(new Set([
      ...(chain.calls ?? []).map(c => c.strike),
      ...(chain.puts  ?? []).map(p => p.strike),
    ])).sort((a, b) => a - b)
    if (!strikes.length) continue

    const atm = strikes.reduce((closest, s) =>
      Math.abs(s - spotPrice) < Math.abs(closest - spotPrice) ? s : closest, strikes[0])

    const atmCall = (chain.calls ?? []).find(c => c.strike === atm) ?? null
    const atmPut  = (chain.puts  ?? []).find(p => p.strike === atm) ?? null

    const label = new Date(exp + 'T08:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

    const spreads = [atmCall, atmPut].flatMap(contract => {
      const bid = resolveBid(contract)
      const ask = resolveAsk(contract)
      if (bid <= 0 || ask <= 0 || ask < bid) return []
      const mid = (bid + ask) / 2
      if (mid <= 0) return []
      return [{ spreadUsd: ask - bid, spreadPct: ((ask - bid) / mid) * 100 }]
    })
    if (!spreads.length) continue

    const avgSpreadUsd = spreads.reduce((s, r) => s + r.spreadUsd, 0) / spreads.length
    const avgSpreadPct = spreads.reduce((s, r) => s + r.spreadPct, 0) / spreads.length
    results.push({
      exp,
      label,
      spreadUsd: Number(avgSpreadUsd.toFixed(2)),
      spreadPct: Number(avgSpreadPct.toFixed(2)),
    })
  }
  return results
}

function computeRawSurface(expirations, response, spotPrice, now) {
  const bucketCenters = makeStrikeDerivedBucketCenters(expirations, response, spotPrice)
  if (!bucketCenters.length) return { expiries: [], buckets: [], cells: [] }
  const bucketLabels = formatUniqueBucketLabels(bucketCenters)
  const bucketLabelByCenter = new Map(bucketCenters.map((center, index) => [center, bucketLabels[index]]))

  const buckets = bucketCenters.map(center => ({
    key: center,
    label: bucketLabelByCenter.get(center),
    moneynessPct: Number((((Math.exp(center) - 1) * 100)).toFixed(1)),
  }))

  const cells = []
  const expiryRows = []

  for (const exp of expirations) {
    const chain = response.data[exp]
    if (!chain) continue

    const expiryMs = new Date(exp + 'T08:00:00Z').getTime()
    const dte = Math.round(Math.max(1e-4, (expiryMs - now) / MS_PER_YEAR) * 365.25)
    const label = new Date(exp + 'T08:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const bucketMap = new Map(bucketCenters.map(center => [center, []]))

    for (const c of chain.calls ?? []) {
      const mv = c.markVol ?? 0
      if (c.strike < spotPrice || mv <= 0) continue
      const k = Math.log(c.strike / spotPrice)
      const center = bucketCenters.reduce((best, cur) =>
        Math.abs(cur - k) < Math.abs(best - k) ? cur : best
      )
      bucketMap.get(center)?.push({ iv: mv * 100, strike: c.strike, optionType: 'call' })
    }

    for (const p of chain.puts ?? []) {
      const mv = p.markVol ?? 0
      if (p.strike > spotPrice || mv <= 0) continue
      const k = Math.log(p.strike / spotPrice)
      const center = bucketCenters.reduce((best, cur) =>
        Math.abs(cur - k) < Math.abs(best - k) ? cur : best
      )
      bucketMap.get(center)?.push({ iv: mv * 100, strike: p.strike, optionType: 'put' })
    }

    let cellCount = 0
    for (const center of bucketCenters) {
      const points = bucketMap.get(center) ?? []
      if (!points.length) continue

      cellCount++
      const ivSum = points.reduce((sum, point) => sum + point.iv, 0)
      const strikes = points.map(point => point.strike)
      const optionTypes = Array.from(new Set(points.map(point => point.optionType)))
      cells.push({
        exp,
        label,
        dte,
        bucketKey: center,
        bucketLabel: bucketLabelByCenter.get(center),
        moneynessPct: Number((((Math.exp(center) - 1) * 100)).toFixed(1)),
        avgMarkIV: Number((ivSum / points.length).toFixed(1)),
        count: points.length,
        minStrike: Math.min(...strikes),
        maxStrike: Math.max(...strikes),
        optionTypes,
      })
    }

    if (cellCount > 0) {
      expiryRows.push({ exp, label, dte })
    }
  }

  return { expiries: expiryRows, buckets, cells }
}

export function computeAnalysis(response, spotPrice) {
  if (!response || !spotPrice || !response.expirations?.length) return null

  const now = Date.now()
  const expirations = response.expirations.filter(exp => {
    return new Date(exp + 'T08:00:00Z').getTime() > now
  })

  if (!expirations.length) return null

  const rawSurface = computeRawSurface(expirations, response, spotPrice, now)

  // Compute SVI fits
  const sviFits = {}
  for (const exp of expirations) {
    const chain = response.data[exp]
    if (!chain?.calls?.length || !chain?.puts?.length) continue

    const expiryMs = new Date(exp + 'T08:00:00Z').getTime()
    const T = Math.max(1e-4, (expiryMs - now) / MS_PER_YEAR)

    const ks = []
    const wObs = []

    for (const c of chain.calls) {
      const mv = c.markVol ?? 0
      if (c.strike < spotPrice || mv <= 0) continue
      ks.push(Math.log(c.strike / spotPrice))
      wObs.push(mv * mv * T)
    }
    for (const p of chain.puts) {
      const mv = p.markVol ?? 0
      if (p.strike > spotPrice || mv <= 0) continue
      ks.push(Math.log(p.strike / spotPrice))
      wObs.push(mv * mv * T)
    }

    const fit = fitSVI(ks, wObs)
    sviFits[exp] = fit ? { ...fit, T } : null
  }

  // Compute term structure
  const termStructure = []
  for (const exp of expirations) {
    const expiryMs = new Date(exp + 'T08:00:00Z').getTime()
    const T = Math.max(1e-4, (expiryMs - now) / MS_PER_YEAR)
    const dte = Math.round(T * 365.25)
    const fit = sviFits[exp]
    const label = new Date(exp + 'T08:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

    let atmIV = null
    if (fit) {
      atmIV = Math.round(sviIV(0, T, fit.params) * 1000) / 10
    } else {
      const chain = response.data[exp]
      const allContracts = [...(chain?.calls ?? []), ...(chain?.puts ?? [])]
      if (allContracts.length) {
        const atm = allContracts.reduce((b, c) =>
          Math.abs(c.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? c : b
        )
        if (atm?.markVol) atmIV = Math.round(atm.markVol * 1000) / 10
      }
    }

    if (atmIV !== null) termStructure.push({ label, dte, atmIV, exp })
  }

  // Compute 25Δ skew data
  const skewData = []
  for (const exp of expirations) {
    const chain = response.data[exp]
    if (!chain?.calls?.length || !chain?.puts?.length) continue
    if (!chain.calls.some(c => c.delta !== undefined && c.delta !== 0)) continue

    const call25 = chain.calls.reduce((best, c) => {
      if (!c.delta || c.delta < 0.05 || c.delta > 0.5) return best
      return !best || Math.abs(c.delta - 0.25) < Math.abs(best.delta - 0.25) ? c : best
    }, null)

    const put25 = chain.puts.reduce((best, p) => {
      if (!p.delta || p.delta > -0.05 || p.delta < -0.5) return best
      return !best || Math.abs(p.delta + 0.25) < Math.abs(best.delta + 0.25) ? p : best
    }, null)

    const atmCall = chain.calls.reduce((b, c) =>
      Math.abs(c.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? c : b
    )

    if (!call25?.markVol || !put25?.markVol || !atmCall?.markVol) continue

    const rr = parseFloat(((call25.markVol - put25.markVol) * 100).toFixed(2))
    const bf = parseFloat((((call25.markVol + put25.markVol) / 2 - atmCall.markVol) * 100).toFixed(2))
    const label = new Date(exp + 'T08:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    skewData.push({ label, rr, bf, exp })
  }

  const atmBboSpread = computeAtmBboSpread(expirations, response, spotPrice)

  return { sviFits, termStructure, skewData, rawSurface, atmBboSpread, updatedAt: now }
}

export function updateAnalysisCache(cacheKey, response, spotPrice) {
  const result = computeAnalysis(response, spotPrice)
  if (result) analysisCache[cacheKey] = result
}
