import test from 'node:test'
import assert from 'node:assert/strict'

const { fetchJsonOrThrow } = await import('./lib/fetchJson.js')

test('fetchJsonOrThrow rejects empty non-json error responses', async () => {
  const response = new Response('', { status: 404, statusText: 'Not Found' })

  await assert.rejects(
    fetchJsonOrThrow(response, 'Failed to load OKX portfolio'),
    /Failed to load OKX portfolio/,
  )
})

test('fetchJsonOrThrow parses valid json payloads', async () => {
  const response = new Response(JSON.stringify({ ok: true }), { status: 200 })

  const payload = await fetchJsonOrThrow(response, 'failed')
  assert.deepEqual(payload, { ok: true })
})
