export function apiPath(path) {
  const normalized = String(path ?? '').replace(/^\/+/, '')
  return `/${normalized.startsWith('api/') ? normalized : `api/${normalized}`}`
}

export function ssePath(path) {
  const base = process.env.NEXT_PUBLIC_SSE_BASE_URL || ''
  return `${base}${apiPath(path)}`
}
