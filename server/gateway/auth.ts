import { createHash, timingSafeEqual } from 'node:crypto'

// The gateway's only credential. HTTP Basic carries it on every request, so the check is cheap and constant-time, and
// failures are throttled globally (not per address: behind the published port every client looks alike).

export type PasswordResult = { ok: true } | { ok: false; status: 401 | 429; retryAfterS?: number }

export type PasswordCheckOptions = { password: string; now?: () => number; failureLimit?: number; windowMs?: number; lockoutMs?: number }

const digest = (text: string) => createHash('sha256').update(text).digest()

/** The password part of `Basic base64(user:password)`, or null if the header is not that. The username is ignored. */
function basicPassword(header: string | undefined): string | null {
  const match = /^basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header ?? '')
  if (match === null) return null
  const text = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = text.indexOf(':')
  return colon < 0 ? null : text.slice(colon + 1)
}

export function createPasswordCheck(opts: PasswordCheckOptions): { check(authorizationHeader: string | undefined): PasswordResult } {
  const now = opts.now ?? (() => performance.now())
  const failureLimit = opts.failureLimit ?? 8
  const windowMs = opts.windowMs ?? 5 * 60_000
  const lockoutMs = opts.lockoutMs ?? 5 * 60_000
  const expected = digest(opts.password)
  let failures: number[] = []
  let lockedUntil = 0

  return {
    check(header) {
      const t = now()
      // During a lockout nothing is compared, so a right password cannot be confirmed by guessing, and the lock is not extended.
      if (t < lockedUntil) return { ok: false, status: 429, retryAfterS: Math.ceil((lockedUntil - t) / 1000) }
      const given = basicPassword(header)
      // Always hash and compare, so a malformed header takes about as long as a wrong password.
      if (timingSafeEqual(digest(given ?? ''), expected) && given !== null) return { ok: true }
      failures = failures.filter((at) => t - at < windowMs)
      failures.push(t)
      if (failures.length >= failureLimit) {
        failures = []
        lockedUntil = t + lockoutMs
      }
      return { ok: false, status: 401 }
    },
  }
}
