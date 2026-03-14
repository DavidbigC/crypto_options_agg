export function attachSseLease({ req, res, leaseMs, onCleanup = () => {} }) {
  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearTimeout(leaseTimer)
    onCleanup()
  }

  const leaseTimer = setTimeout(() => {
    res.end()
    cleanup()
  }, leaseMs)

  req.on('close', cleanup)

  return cleanup
}
