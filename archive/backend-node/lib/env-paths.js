import path from 'node:path'

export function getEnvPaths(backendDir) {
  return [
    path.join(backendDir, '.env'),
    path.join(path.dirname(backendDir), '.env'),
  ]
}
