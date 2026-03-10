/**
 * Filter expirations to only show future dates.
 * For today's date: visible before 08:00 UTC (standard crypto expiry time), hidden after.
 */
export function filterExpirations(expirations: string[]): string[] {
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setUTCHours(8, 0, 0, 0)
  const pastCutoff = Date.now() >= cutoff.getTime()

  return expirations.filter(e => {
    if (e > today) return true
    if (e < today) return false
    return !pastCutoff   // today: show only before 08:00 UTC
  })
}
