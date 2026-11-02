import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MAX_SESSIONS, SESSION_COOKIE, SESSION_TTL_MS, authenticatedSession, createSessionStore, sessionIdsFromCookie, sessionKey } from './session.js'

function setup(start = 1_000_000) {
  let t = start
  const store = createSessionStore({ now: () => t })
  return { store, advance: (ms: number) => { t += ms }, at: () => t }
}

describe('constants', () => {
  it('has the expected values', () => {
    expect(SESSION_TTL_MS).toBe(28_800_000)
    expect(MAX_SESSIONS).toBe(20)
    expect(SESSION_COOKIE).toBe('vo_session')
  })
})

describe('createSessionStore', () => {
  it('creates 43-char base64url ids that differ per call', () => {
    const { store } = setup()
    const a = store.create()
    const b = store.create()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.expiresAt).toBe(1_000_000 + SESSION_TTL_MS)
  })

  it('is valid until expiresAt and invalid at and after it', () => {
    const { store, advance } = setup()
    const { id } = store.create()
    advance(SESSION_TTL_MS - 1)
    expect(store.valid(id)).toBe(true)
    advance(1)
    expect(store.valid(id)).toBe(false)
    advance(1)
    expect(store.valid(id)).toBe(false)
  })

  it('destroy invalidates and returns true once then false', () => {
    const { store } = setup()
    const { id } = store.create()
    expect(store.destroy(id)).toBe(true)
    expect(store.valid(id)).toBe(false)
    expect(store.destroy(id)).toBe(false)
    expect(store.destroy(undefined)).toBe(false)
  })

  it('drops the oldest when the 21st is created', () => {
    const { store } = setup()
    const first = store.create()
    const rest = Array.from({ length: MAX_SESSIONS - 1 }, () => store.create())
    expect(store.size).toBe(MAX_SESSIONS)
    const next = store.create()
    expect(store.valid(first.id)).toBe(false)
    expect(store.valid(rest[0]!.id)).toBe(true)
    expect(store.valid(next.id)).toBe(true)
    expect(store.size).toBe(MAX_SESSIONS)
  })

  it('purges expired entries on create', () => {
    const { store, advance } = setup()
    store.create()
    store.create()
    advance(SESSION_TTL_MS)
    store.create()
    expect(store.size).toBe(1)
  })

  it('rejects unknown and undefined ids', () => {
    const { store } = setup()
    store.create()
    expect(store.valid('nope')).toBe(false)
    expect(store.valid(undefined)).toBe(false)
  })

  it('stores only hashes, never raw ids', () => {
    const { store } = setup()
    const { id } = store.create()
    const hash = createHash('sha256').update(id).digest('hex')
    const keys = store.debugKeys()
    expect(keys).toEqual([hash])
    expect(JSON.stringify(keys)).not.toContain(id)
    expect(store.valid(hash)).toBe(false)
  })
})

describe('sessionIdsFromCookie', () => {
  it('parses among other cookies', () => {
    expect(sessionIdsFromCookie('a=1; vo_session=abc; b=2')).toEqual(['abc'])
    expect(sessionIdsFromCookie('  vo_session=abc  ')).toEqual(['abc'])
  })
  it('returns every duplicate in order', () => {
    expect(sessionIdsFromCookie('vo_session=x; vo_session=y')).toEqual(['x', 'y'])
  })
  it('returns [] when missing, empty or too long, and skips over-long values only', () => {
    expect(sessionIdsFromCookie(undefined)).toEqual([])
    expect(sessionIdsFromCookie('a=1')).toEqual([])
    expect(sessionIdsFromCookie('vo_session=')).toEqual([])
    expect(sessionIdsFromCookie(`vo_session=${'a'.repeat(129)}`)).toEqual([])
    expect(sessionIdsFromCookie(`vo_session=${'a'.repeat(129)}; vo_session=ok`)).toEqual(['ok'])
    expect(sessionIdsFromCookie(`vo_session=${'a'.repeat(128)}`)).toEqual(['a'.repeat(128)])
  })
  it('keeps at most 8 values', () => {
    const header = Array.from({ length: 12 }, (_, i) => `vo_session=v${i}`).join('; ')
    expect(sessionIdsFromCookie(header)).toEqual(Array.from({ length: 8 }, (_, i) => `v${i}`))
  })
})

describe('authenticatedSession', () => {
  it('returns the first VALID id, skipping garbage set by another page', () => {
    const { store } = setup()
    const { id } = store.create()
    expect(authenticatedSession({ headers: { cookie: `vo_session=garbage; vo_session=${id}` } }, store)).toBe(id)
    expect(authenticatedSession({ headers: { cookie: `vo_session=${id}; vo_session=garbage` } }, store)).toBe(id)
  })
  it('returns undefined with no valid id or no cookie', () => {
    const { store } = setup()
    store.create()
    expect(authenticatedSession({ headers: { cookie: 'vo_session=garbage' } }, store)).toBeUndefined()
    expect(authenticatedSession({ headers: {} }, store)).toBeUndefined()
  })
})

describe('onEnd', () => {
  it('fires once with the hashed key on destroy, never for an unknown id', () => {
    const { store } = setup()
    const keys: string[] = []
    store.onEnd((k) => keys.push(k))
    const { id } = store.create()
    store.destroy('unknown')
    expect(keys).toEqual([])
    store.destroy(id)
    store.destroy(id)
    expect(keys).toEqual([sessionKey(id)])
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(keys[0]).not.toBe(id)
  })
  it('fires on eviction of the oldest', () => {
    const { store } = setup()
    const keys: string[] = []
    store.onEnd((k) => keys.push(k))
    const first = store.create()
    for (let i = 0; i < MAX_SESSIONS; i++) store.create()
    expect(keys).toEqual([sessionKey(first.id)])
  })
  it('fires on expiry purge', () => {
    const { store, advance } = setup()
    const keys: string[] = []
    store.onEnd((k) => keys.push(k))
    const a = store.create()
    advance(SESSION_TTL_MS)
    expect(store.valid(a.id)).toBe(false)
    expect(keys).toEqual([sessionKey(a.id)])
  })
  it('a throwing listener breaks neither the others nor create/destroy/purge', () => {
    const { store, advance } = setup()
    const keys: string[] = []
    store.onEnd(() => { throw new Error('boom') })
    store.onEnd((k) => keys.push(k))
    const a = store.create()
    expect(store.destroy(a.id)).toBe(true)
    const b = store.create()
    advance(SESSION_TTL_MS)
    expect(() => store.create()).not.toThrow()
    expect(keys).toEqual([sessionKey(a.id), sessionKey(b.id)])
    expect(store.size).toBe(1)
  })
})
