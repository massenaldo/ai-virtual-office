import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MAX_SESSIONS, SESSION_COOKIE, SESSION_TTL_MS, createSessionStore, sessionIdFromCookie } from './session.js'

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

describe('sessionIdFromCookie', () => {
  it('parses among other cookies', () => {
    expect(sessionIdFromCookie('a=1; vo_session=abc; b=2')).toBe('abc')
    expect(sessionIdFromCookie('  vo_session=abc  ')).toBe('abc')
  })
  it('first duplicate wins', () => {
    expect(sessionIdFromCookie('vo_session=x; vo_session=y')).toBe('x')
  })
  it('returns undefined when missing or too long', () => {
    expect(sessionIdFromCookie(undefined)).toBeUndefined()
    expect(sessionIdFromCookie('a=1')).toBeUndefined()
    expect(sessionIdFromCookie(`vo_session=${'a'.repeat(129)}`)).toBeUndefined()
    expect(sessionIdFromCookie(`vo_session=${'a'.repeat(128)}`)).toBe('a'.repeat(128))
  })
})
