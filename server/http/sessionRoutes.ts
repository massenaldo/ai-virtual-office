import { tokenEquals } from '../auth'
import type { AuditLog } from '../audit'
import { SESSION_COOKIE, SESSION_TTL_MS, sessionIdFromCookie, type SessionStore } from '../session'
import { HttpError, type Reply, type Route } from './router'

export const PAIRING_FAILURES_PER_MINUTE = 10
export const PAIRING_WINDOW_MS = 60_000

export type SessionRouteDeps = { sessions: SessionStore; apiToken: string; audit: AuditLog; now: () => string }

const COOKIE_ATTRS = 'HttpOnly; SameSite=Strict; Path=/api'

/** The pairing body is exactly `{ token }`; anything else is a 400 and never touches the failure counter. A wrong type is not a 400: it is a failed pairing. */
function parsePairing(b: Record<string, unknown>): { token: unknown } {
  for (const key of Object.keys(b)) if (key !== 'token') throw new HttpError(400, `Unknown field "${key}".`, 'unknown_field')
  return { token: b.token }
}

export function createSessionRoutes({ sessions, apiToken, audit, now }: SessionRouteDeps): Route[] {
  // Fixed window: starts at the first failure, ends 60 s later, then the count resets.
  let windowStart = 0
  let failures = 0
  const limited = (): boolean => {
    const t = Date.parse(now())
    if (t - windowStart >= PAIRING_WINDOW_MS || t < windowStart) { windowStart = t; failures = 0 }
    return failures >= PAIRING_FAILURES_PER_MINUTE
  }

  return [
    {
      method: 'POST',
      path: '/api/session',
      body: 'json',
      handler: ({ req, body, requestId }): Reply => {
        if (limited()) {
          audit.write({ action: 'session.rejected', actor: 'api', requestId, reason: 'rate_limited' })
          return { status: 429, body: { error: 'Too many attempts.' } }
        }
        const { token } = parsePairing(body as Record<string, unknown>)
        if (typeof token !== 'string' || !tokenEquals(apiToken, token)) {
          failures++
          audit.write({ action: 'session.rejected', actor: 'api', requestId, reason: 'bad_token' })
          return { status: 401, body: { error: 'Unauthorized.' }, headers: { 'www-authenticate': 'Bearer' } }
        }
        const { id, expiresAt } = sessions.create()
        audit.write({ action: 'session.created', actor: 'api', requestId })
        const secure = (req.headers.origin ?? '').startsWith('https:') ? '; Secure' : ''
        return {
          status: 200,
          body: { ok: true, expiresAt: new Date(expiresAt).toISOString() },
          headers: { 'set-cookie': `${SESSION_COOKIE}=${id}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_MS / 1000}${secure}` },
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/session',
      handler: ({ req, requestId }): Reply => {
        if (sessions.destroy(sessionIdFromCookie(req.headers.cookie))) audit.write({ action: 'session.ended', actor: 'api', requestId })
        return { status: 204, body: null, headers: { 'set-cookie': `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0` } }
      },
    },
  ]
}
