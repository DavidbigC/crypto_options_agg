import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function read(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('desk chain grouped headers match the actual 10/1/10 column layout', async () => {
  const [combined, singleVenue] = await Promise.all([
    read('./components/CombinedOptionsChain.tsx'),
    read('./components/OptionsChain.tsx'),
  ])

  for (const source of [combined, singleVenue]) {
    assert.match(source, /<th colSpan=\{10\}[^>]*>Calls<\/th>/)
    assert.match(source, /<th className="w-16" \/>/)
    assert.match(source, /<th colSpan=\{10\}[^>]*>Puts<\/th>/)
    assert.doesNotMatch(source, /<th colSpan=\{11\}[^>]*>Calls<\/th>/)
    assert.doesNotMatch(source, /<th colSpan=\{11\}[^>]*>Puts<\/th>/)
  }
})
