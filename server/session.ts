import { createHash, randomBytes } from 'node:crypto'

export const SESSION_TTL_MS = 28_800_000
export const MAX_SESSIONS = 20
export const SESSION_COOKIE = 'vo_session'
const MAX_ID_LENGTH = 128

export type SessionStore = {
  create(): { id: string; expiresAt: number }
  valid(id: string | undefined): boolean
  destroy(id: string | undefined): boolean
  readonly size: number
  /** TEST-ONLY: the stored map keys (hashes), to assert raw ids are never stored. */
  debugKeys(): string[]
}

const hashId = (id: string): string => createHash('sha256').update(id).digest('hex')

/** In-memory session store: 256-bit random ids, only SHA-256 hashes kept, expiry checked on every use. */
export function createSessionStore(opts: { now: () => number }): SessionStore {
  // Map preserves insertion order, so the first key is the oldest session.
  const sessions = new Map<string, number>()

  const purge = (): void => {
    const t = opts.now()
    for (const [key, expiresAt] of sessions) if (expiresAt <= t) sessions.delete(key)
  }

  return {
    create() {
      purge()
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      const id = randomBytes(32).toString('base64url')
      const expiresAt = opts.now() + SESSION_TTL_MS
      sessions.set(hashId(id), expiresAt)
      return { id, expiresAt }
    },
    valid(id) {
      if (!id || id.length > MAX_ID_LENGTH) return false
      purge()
      const expiresAt = sessions.get(hashId(id))
      return expiresAt !== undefined && expiresAt > opts.now()
    },
    destroy(id) {
      if (!id || id.length > MAX_ID_LENGTH) return false
      return sessions.delete(hashId(id))
    },
    get size() { return sessions.size },
    debugKeys() { return [...sessions.keys()] },
  }
}

/** Returns the first vo_session value of a Cookie header, or undefined if absent or over 128 characters. */
export function sessionIdFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined
  }
  return undefined
}
