import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mergeEnv } from '../server/config'
import { findSecretLeaks, type BuiltFile } from './secretScan'

// Reads the already-built dist/ and dist-server/ and fails if a key (or its variable name, outside the server bundle) is in them.
// It builds nothing and starts no process: run `npm run build` and `npm run server:build` first.

const DIRS = ['dist', 'dist-server']

if (!DIRS.every((d) => existsSync(d))) {
  console.error('Run npm run build and npm run server:build first.')
  process.exit(1)
}

const files: BuiltFile[] = DIRS.flatMap((dir) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => `${dir}/${rel}`.replaceAll('\\', '/'))
    .filter((path) => statSync(join(path)).isFile())
    .map((path) => ({ path, text: readFileSync(path, 'utf8') })),
)

let envText: string | null = null
try { envText = readFileSync('.env', 'utf8') } catch { envText = null }
const key = mergeEnv(envText, process.env).ANTHROPIC_API_KEY

const problems = findSecretLeaks(files, key)
if (problems.length > 0) {
  for (const p of problems) console.error(p)
  process.exit(1)
}
console.log(`No secrets found in dist/ or dist-server/ (${files.length} files checked).`)
