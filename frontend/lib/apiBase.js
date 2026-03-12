export function apiPath(path) {
  const normalized = String(path ?? '').replace(/^\/+/, '')
  return `/${normalized.startsWith('api/') ? normalized : `api/${normalized}`}`
}

export function ssePath(path) {
  return apiPath(path)
}
