import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { getEnvPaths } from './lib/env-paths.js'

test('getEnvPaths includes backend and project root env files', () => {
  const backendDir = '/tmp/project/backend'
  const paths = getEnvPaths(backendDir)

  assert.deepEqual(paths, [
    path.join(backendDir, '.env'),
    path.join('/tmp/project', '.env'),
  ])
})
