import { fitSVI, sviIV } from './svi.js'

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000
const RAW_SURFACE_BUCKET_STEP = 0.05
const RAW_SURFACE_BUCKET_MIN = -0.35
const RAW_SURFACE_BUCKET_MAX = 0.35

export const analysisCache = {}

function makeRawSurfaceBucketCenters() {
  const centers = []
  for (let bucket = RAW_SURFACE_BUCKET_MIN; bucket <= RAW_SURFACE_BUCKET_MAX + 1e-9; bucket += RAW_SURFACE_BUCKET_STEP) {
    centers.push(Number(bucket.toFixed(3)))
  }
  return centers
}

function formatBucketLabel(bucketCenter) {
  if (Math.abs(bucketCenter) < RAW_SURFACE_BUCKET_STEP / 2) return 'ATM'

  const pct = (Math.exp(bucketCenter) - 1) * 100
  const rounded = Math.round(pct / 5) * 5
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

function computeRawSurface(expirations, response, spotPrice, now) {
  const bucketCenters = makeRawSurfaceBucketCenters()
  const buckets = bucketCenters.map(center => ({
    key: center,
    label: formatBucketLabel(center),
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
      const center = bucketCenters.reduce((best, current) =>
        Math.abs(current - k) < Math.abs(best - k) ? current : best
      )
      if (Math.abs(center - k) <= RAW_SURFACE_BUCKET_STEP / 2) {
        bucketMap.get(center)?.push({ iv: mv * 100, strike: c.strike, optionType: 'call' })
      }
    }

    for (const p of chain.puts ?? []) {
      const mv = p.markVol ?? 0
      if (p.strike > spotPrice || mv <= 0) continue
      const k = Math.log(p.strike / spotPrice)
      const center = bucketCenters.reduce((best, current) =>
        Math.abs(current - k) < Math.abs(best - k) ? current : best
      )
      if (Math.abs(center - k) <= RAW_SURFACE_BUCKET_STEP / 2) {
        bucketMap.get(center)?.push({ iv: mv * 100, strike: p.strike, optionType: 'put' })
      }
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
        bucketLabel: formatBucketLabel(center),
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

  return { sviFits, termStructure, skewData, rawSurface, updatedAt: now }
}

export function updateAnalysisCache(cacheKey, response, spotPrice) {
  const result = computeAnalysis(response, spotPrice)
  if (result) analysisCache[cacheKey] = result
}
