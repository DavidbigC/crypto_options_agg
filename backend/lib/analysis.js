import { fitSVI, sviIV } from './svi.js'

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000

export const analysisCache = {}

export function computeAnalysis(response, spotPrice) {
  if (!response || !spotPrice || !response.expirations?.length) return null

  const now = Date.now()
  const expirations = response.expirations.filter(exp => {
    return new Date(exp + 'T08:00:00Z').getTime() > now
  })

  if (!expirations.length) return null

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

    sviFits[exp] = fitSVI(ks, wObs)
  }

  // Compute term structure
  const termStructure = []
  for (const exp of expirations) {
    const expiryMs = new Date(exp + 'T08:00:00Z').getTime()
    const T = Math.max(1e-4, (expiryMs - now) / MS_PER_YEAR)
    const dte = Math.round(T * 365.25)
    const fit = sviFits[exp]
    const label = new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

    let atmIV = null
    if (fit) {
      atmIV = Math.round(sviIV(0, T, fit.params) * 1000) / 10
    } else {
      const chain = response.data[exp]
      if (chain?.calls?.length) {
        const atm = chain.calls.reduce((b, c) =>
          Math.abs(c.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? c : b
        )
        if (atm.markVol) atmIV = Math.round(atm.markVol * 1000) / 10
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
    const label = new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    skewData.push({ label, rr, bf, exp })
  }

  return { sviFits, termStructure, skewData, updatedAt: now }
}

export function updateAnalysisCache(cacheKey, response, spotPrice) {
  const result = computeAnalysis(response, spotPrice)
  if (result) analysisCache[cacheKey] = result
}
