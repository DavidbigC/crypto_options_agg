const FRESH_MS = 30_000
const STALE_MS = 90_000

function roundTo(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function indexRowsByExpiry(rows = [], valueKey) {
  const map = new Map()
  for (const row of rows) {
    map.set(row.exp, valueKey ? row[valueKey] : row)
  }
  return map
}

function formatExpiryLabel(exp) {
  return new Date(exp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function average(values) {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function buildTermStructureChartData(datasets, overlays, mode = 'level') {
  const combinedRows = datasets.combined?.termStructure ?? []
  return combinedRows.map((row) => {
    const chartRow = {
      exp: row.exp,
      label: row.label,
      dte: row.dte,
      combined: mode === 'spread' ? 0 : row.atmIV,
    }

    for (const exchange of overlays) {
      const overlayMap = indexRowsByExpiry(datasets[exchange]?.termStructure, 'atmIV')
      const overlayValue = overlayMap.get(row.exp)
      chartRow[exchange] = overlayValue == null
        ? null
        : mode === 'spread'
          ? roundTo(overlayValue - row.atmIV, 2)
          : overlayValue
    }

    return chartRow
  })
}

export function buildSkewChartData(datasets, overlays, metric, mode = 'level') {
  const combinedRows = datasets.combined?.skewData ?? []
  return combinedRows.map((row) => {
    const chartRow = {
      exp: row.exp,
      label: row.label,
      dte: row.dte,
      combined: mode === 'spread' ? 0 : row[metric],
    }

    for (const exchange of overlays) {
      const overlayMap = indexRowsByExpiry(datasets[exchange]?.skewData, metric)
      const overlayValue = overlayMap.get(row.exp)
      chartRow[exchange] = overlayValue == null
        ? null
        : mode === 'spread'
          ? roundTo(overlayValue - row[metric], 2)
          : overlayValue
    }

    return chartRow
  })
}

export function buildSurfaceComparison(combinedSurface, venueSurface) {
  const venueCells = new Map(
    (venueSurface?.cells ?? []).map((cell) => [`${cell.exp}|${cell.bucketKey}`, cell])
  )

  return {
    expiries: combinedSurface?.expiries ?? [],
    buckets: combinedSurface?.buckets ?? [],
    cells: (combinedSurface?.cells ?? []).map((combinedCell) => {
      const venueCell = venueCells.get(`${combinedCell.exp}|${combinedCell.bucketKey}`) ?? null
      return {
        ...combinedCell,
        venueAvgMarkIV: venueCell?.avgMarkIV ?? null,
        venueCount: venueCell?.count ?? 0,
        spread: venueCell ? roundTo(venueCell.avgMarkIV - combinedCell.avgMarkIV, 2) : null,
      }
    }),
  }
}

export function getDatasetFreshness(updatedAt, now = Date.now()) {
  if (!updatedAt) {
    return { status: 'missing', ageMs: null, label: 'Unavailable' }
  }

  const ageMs = Math.max(0, now - updatedAt)
  if (ageMs <= FRESH_MS) {
    return { status: 'fresh', ageMs, label: 'Current' }
  }
  if (ageMs <= STALE_MS) {
    return { status: 'aging', ageMs, label: `${Math.round(ageMs / 1000)}s old` }
  }
  return { status: 'stale', ageMs, label: `${Math.round(ageMs / 1000)}s old` }
}
