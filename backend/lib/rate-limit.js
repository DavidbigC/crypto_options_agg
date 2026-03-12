function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

export function createRateLimiter({
  limit,
  windowMs,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map()

  return function rateLimit(req, res, next) {
    const key = `${req.method}:${req.path}:${getClientIp(req)}`
    const currentNow = now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= currentNow) {
      buckets.set(key, { count: 1, resetAt: currentNow + windowMs })
      return next()
    }

    if (bucket.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentNow) / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    bucket.count += 1
    return next()
  }
}
