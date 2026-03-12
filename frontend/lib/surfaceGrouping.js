function roundTo(value, digits = 1) {
  return Number(value.toFixed(digits))
}

function formatGroupedBucketLabel(group) {
  if (group.length === 1) return group[0].label
  return `${group[0].label} to ${group[group.length - 1].label}`
}

function makeBucketGroups(buckets, maxColumns) {
  if (!Array.isArray(buckets) || buckets.length <= maxColumns) {
    return buckets.map((bucket, index) => ({
      key: `group-${index}`,
      label: bucket.label,
      startKey: bucket.key,
      endKey: bucket.key,
      moneynessPct: bucket.moneynessPct,
      bucketKeys: [bucket.key],
    }))
  }

  const targetColumns = Math.max(1, maxColumns)
  const groups = []
  for (let index = 0; index < targetColumns; index++) {
    const start = Math.floor((index * buckets.length) / targetColumns)
    const end = Math.floor(((index + 1) * buckets.length) / targetColumns)
    const slice = buckets.slice(start, end)
    if (!slice.length) continue
    groups.push({
      key: `group-${index}`,
      label: formatGroupedBucketLabel(slice),
      startKey: slice[0].key,
      endKey: slice[slice.length - 1].key,
      moneynessPct: roundTo((slice[0].moneynessPct + slice[slice.length - 1].moneynessPct) / 2),
      bucketKeys: slice.map(bucket => bucket.key),
    })
  }
  return groups
}

export function groupSurfaceBuckets(surface, maxColumns = 25) {
  if (!surface?.buckets?.length) {
    return { expiries: surface?.expiries ?? [], buckets: [], cells: [] }
  }

  const groups = makeBucketGroups(surface.buckets, maxColumns)
  const groupByBucketKey = new Map()
  groups.forEach((group) => {
    group.bucketKeys.forEach((bucketKey) => {
      groupByBucketKey.set(bucketKey, group)
    })
  })

  const cellAcc = new Map()
  for (const cell of surface.cells ?? []) {
    const group = groupByBucketKey.get(cell.bucketKey)
    if (!group) continue
    const key = `${cell.exp}|${group.key}`
    if (!cellAcc.has(key)) {
      cellAcc.set(key, {
        exp: cell.exp,
        label: cell.label,
        dte: cell.dte,
        bucketKey: group.startKey,
        bucketLabel: group.label,
        moneynessPct: group.moneynessPct,
        ivSum: 0,
        count: 0,
        minStrike: Number.POSITIVE_INFINITY,
        maxStrike: Number.NEGATIVE_INFINITY,
        optionTypes: new Set(),
      })
    }
    const acc = cellAcc.get(key)
    acc.ivSum += cell.avgMarkIV * cell.count
    acc.count += cell.count
    acc.minStrike = Math.min(acc.minStrike, cell.minStrike)
    acc.maxStrike = Math.max(acc.maxStrike, cell.maxStrike)
    cell.optionTypes.forEach(type => acc.optionTypes.add(type))
  }

  return {
    expiries: surface.expiries ?? [],
    buckets: groups.map(group => ({
      key: group.startKey,
      label: group.label,
      moneynessPct: group.moneynessPct,
    })),
    cells: Array.from(cellAcc.values()).map((cell) => ({
      exp: cell.exp,
      label: cell.label,
      dte: cell.dte,
      bucketKey: cell.bucketKey,
      bucketLabel: cell.bucketLabel,
      moneynessPct: cell.moneynessPct,
      avgMarkIV: roundTo(cell.ivSum / cell.count),
      count: cell.count,
      minStrike: cell.minStrike,
      maxStrike: cell.maxStrike,
      optionTypes: Array.from(cell.optionTypes).sort(),
    })),
  }
}
