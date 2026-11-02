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
  /** Calls `listener` with the session's key (a hash, never the id) whenever a session ends: destroyed, evicted or expired. */
  onEnd(listener: (key: string) => void): void
  /** TEST-ONLY: the stored map keys (hashes), to assert raw ids are never stored. */
  debugKeys(): string[]
}

const hashId = (id: string): string => createHash('sha256').update(id).digest('hex')

/** The store's key for an id: what `onEnd` listeners receive. */
export const sessionKey = hashId

/** In-memory session store: 256-bit random ids, only SHA-256 hashes kept, expiry checked on every use. */
export function createSessionStore(opts: { now: () => number }): SessionStore {
  // Map preserves insertion order, so the first key is the oldest session.
  const sessions = new Map<string, number>()
  const listeners: Array<(key: string) => void> = []
  // A throwing listener must never break create, destroy or purge (or the listeners after it).
  const ended = (key: string): void => { for (const l of listeners) { try { l(key) } catch { /* ignored on purpose */ } } }

  const purge = (): void => {
    const t = opts.now()
    for (const [key, expiresAt] of sessions) if (expiresAt <= t) { sessions.delete(key); ended(key) }
  }

  return {
    create() {
      purge()
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
        ended(oldest)
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
      const key = hashId(id)
      const removed = sessions.delete(key)
      if (removed) ended(key)
      return removed
    },
    get size() { return sessions.size },
    onEnd(listener) { listeners.push(listener) },
    debugKeys() { return [...sessions.keys()] },
  }
}

const MAX_COOKIE_VALUES = 8

/**
 * Every vo_session value of a Cookie header (at most 8; values over 128 characters or empty are skipped). More than one can
 * arrive when another page on the same host name sets its own, more specific cookie; the caller accepts any valid one.
 */
export function sessionIdsFromCookie(header: string | undefined): string[] {
  const ids: string[] = []
  if (!header) return ids
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    if (value.length === 0 || value.length > MAX_ID_LENGTH) continue
    ids.push(value)
    if (ids.length >= MAX_COOKIE_VALUES) break
  }
  return ids
}

/** The one place a request's session is decided: the first vo_session value that is a valid session, or undefined. Used by the auth guard, logout and the event stream so they cannot disagree. */
export function authenticatedSession(req: { headers: { cookie?: string } }, sessions: Pick<SessionStore, 'valid'>): string | undefined {
  return sessionIdsFromCookie(req.headers.cookie).find((id) => sessions.valid(id))
}

const COOKIE_ATTRS = 'HttpOnly; SameSite=Strict; Path=/api'
const secureFor = (origin: string | undefined): string => ((origin ?? '').startsWith('https:') ? '; Secure' : '')

/** Set-Cookie value for a new session; Secure only when the request Origin is https. */
export const sessionSetCookie = (id: string, origin: string | undefined): string => `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_MS / 1000}${secureFor(origin)}`

/** Set-Cookie value that clears the cookie, with the same attributes (and Secure rule) as the one that set it. */
export const sessionClearCookie = (origin: string | undefined): string => `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0${secureFor(origin)}`
