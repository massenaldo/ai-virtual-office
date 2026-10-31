import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

// The local API token. It lives in the server process and, when generated, in DATA_DIR/api-token (mode 0600) so a
// separately started Vite dev server can read it. It is never put in a URL, a log line, an audit record, a response or a
// frontend variable. Rotation = restart (generated) or change API_TOKEN (configured).

export const TOKEN_FILE = 'api-token'
export const MIN_TOKEN_CHARS = 32

/** The token in use. The value sits behind a getter (not an own property) so JSON, console and inspect never show it. */
export class ApiToken {
  readonly #value: string
  constructor(value: string, readonly source: 'configured' | 'generated') { this.#value = value }
  get value(): string { return this.#value }
  toJSON(): { source: string } { return { source: this.source } }
  [inspect.custom](): string { return `ApiToken(${this.source})` }
}

/**
 * A configured token is used as is and never written to disk (a stale generated file is removed, so nothing else can
 * read an old value). Otherwise a fresh 256-bit token is generated and written atomically with mode 0600.
 */
export function resolveApiToken(opts: { configured: string | null; dataDir: string }): ApiToken {
  const file = join(opts.dataDir, TOKEN_FILE)
  if (opts.configured !== null) {
    try { unlinkSync(file) } catch { /* nothing stale to remove */ }
    return new ApiToken(opts.configured, 'configured')
  }
  const value = randomBytes(32).toString('base64url')
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  // A leftover or planted file (or a symlink) at the temporary name is removed, never opened: 'wx' fails rather than following it.
  try { unlinkSync(tmp) } catch { /* nothing to remove */ }
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, `${value}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  return new ApiToken(value, 'generated')
}

const digest = (text: string) => createHash('sha256').update(text).digest()

/** True only for `Authorization: Bearer <token>`. Compares fixed-length digests in constant time. */
export function tokenMatches(expected: string, header: string | undefined): boolean {
  const match = /^Bearer (\S+)$/i.exec(header ?? '')
  return match !== null && timingSafeEqual(digest(match[1]), digest(expected))
}
