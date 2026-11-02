import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../log'
import { openEventStream } from '../test/sseClient'
import { rawRequest, startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'

const SLOW = { thinkingMs: 60000, workingMs: 60000 }
const JSON_TYPE = { 'content-type': 'application/json' }
const ORIGIN = 'http://localhost:5173'
const HTTPS_ORIGIN = 'https://app.example'

let s: TestServer
let clock = Date.parse('2026-11-02T10:00:00.000Z')
const logger = recordingLogger()
afterEach(async () => { await s.close() })

async function start(env: Record<string, string> = {}) {
  clock = Date.parse('2026-11-02T10:00:00.000Z')
  logger.lines.length = 0
  s = await startTestServer(env, { mockTimings: SLOW, now: () => new Date(clock).toISOString(), log: logger })
}

const pair = (body: unknown, headers: Record<string, string> = {}) =>
  rawRequest(s.url, { method: 'POST', path: '/api/session', noAuth: true, headers: { ...JSON_TYPE, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const cookieOf = (setCookie: string | string[] | undefined): string => String(setCookie).split(';')[0]
const withCookie = (cookie: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  rawRequest(s.url, { path, noAuth: true, method: opts.method, body: opts.body, headers: { cookie, ...(opts.headers ?? {}) } })
const newAgent = JSON.stringify({ name: 'Cookie Agent', role: 'R', department: 'backend' })
const agentNames = async () => (await s.api('GET', '/api/state')).body.state.agents.map((a: { name: string }) => a.name)
const auditText = () => readFileSync(join(s.dataDir, 'audit.log'), 'utf8')

describe('POST /api/session', () => {
  it('pairs with the token and sets an exact cookie', async () => {
    await start()
    const r = await pair({ token: TEST_TOKEN })
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    expect(body).toEqual({ ok: true, expiresAt: new Date(clock + 28_800_000).toISOString() })
    const set = String(r.headers['set-cookie'])
    const id = cookieOf(set).replace('vo_session=', '')
    expect(set).toBe(`vo_session=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`)
    expect(id).not.toBe(TEST_TOKEN)
    expect(id).toHaveLength(43)
    expect(r.body).not.toContain(TEST_TOKEN)
    expect(r.body).not.toContain(id)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(s.app.sessions.size).toBe(1)
  })

  it('adds Secure only for an https Origin', async () => {
    await start({ ALLOWED_ORIGINS: `${HTTPS_ORIGIN},${ORIGIN}` })
    const https = await pair({ token: TEST_TOKEN }, { origin: HTTPS_ORIGIN })
    expect(https.status).toBe(200)
    expect(String(https.headers['set-cookie'])).toMatch(/; Max-Age=28800; Secure$/)
    const http = await pair({ token: TEST_TOKEN }, { origin: ORIGIN })
    expect(String(http.headers['set-cookie'])).not.toContain('Secure')
  })

  it.each([
    ['a wrong token', { token: 'nope' }],
    ['a missing token', {}],
    ['a numeric token', { token: 7 }],
    ['a null token', { token: null }],
    ['an object token', { token: { a: 1 } }],
  ])('answers %s with the plain 401 and no cookie', async (_n, body) => {
    await start()
    const r = await pair(body)
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized.' })
    expect(r.headers['set-cookie']).toBeUndefined()
    expect(s.app.sessions.size).toBe(0)
  })

  it('rejects unknown keys with 400 and no cookie', async () => {
    await start()
    const r = await pair({ token: TEST_TOKEN, extra: 1 })
    expect(r.status).toBe(400)
    expect(r.headers['set-cookie']).toBeUndefined()
  })

  it('refuses a hostile Origin, a foreign Host and a non-JSON type', async () => {
    await start()
    const o = await pair({ token: TEST_TOKEN }, { origin: 'http://evil.example' })
    expect(o.status).toBe(403)
    expect(o.headers['set-cookie']).toBeUndefined()
    expect((await pair({ token: TEST_TOKEN }, { host: `evil.example:${s.port}` })).status).toBe(421)
    const t = await rawRequest(s.url, { method: 'POST', path: '/api/session', noAuth: true, headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token: TEST_TOKEN }) })
    expect(t.status).toBe(415)
    expect(s.app.sessions.size).toBe(0)
  })

  it('limits failed pairings to 10 a minute, even for the right token, until the window rolls over', async () => {
    await start()
    for (let i = 0; i < 10; i++) expect((await pair({ token: `wrong-${i}` })).status).toBe(401)
    const eleventh = await pair({ token: 'wrong-11' })
    expect(eleventh.status).toBe(429)
    expect(JSON.parse(eleventh.body)).toEqual({ error: 'Too many attempts.' })
    const right = await pair({ token: TEST_TOKEN })
    expect(right.status).toBe(429)
    expect(right.headers['set-cookie']).toBeUndefined()
    clock += 59_000
    expect((await pair({ token: TEST_TOKEN })).status).toBe(429)
    clock += 2_000
    expect((await pair({ token: TEST_TOKEN })).status).toBe(200)
  })
})

describe('cookie authentication', () => {
  async function paired() {
    const r = await pair({ token: TEST_TOKEN })
    const cookie = cookieOf(r.headers['set-cookie'])
    return { cookie, id: cookie.replace('vo_session=', '') }
  }

  it('reads with the cookie alone; refuses a destroyed, expired or made-up id', async () => {
    await start()
    const { cookie } = await paired()
    expect((await withCookie(cookie, '/api/state')).status).toBe(200)
    expect((await withCookie('vo_session=bogus', '/api/state')).status).toBe(401)
    clock += 28_800_000
    const expired = await withCookie(cookie, '/api/state')
    expect(expired.status).toBe(401)
    expect(JSON.parse(expired.body)).toEqual({ error: 'Unauthorized.' })
  })

  it('refuses a cookie-only mutation without an allowed Origin, allows it with one', async () => {
    await start()
    const { cookie } = await paired()
    const headers = { ...JSON_TYPE }
    const none = await withCookie(cookie, '/api/agents', { method: 'POST', headers, body: newAgent })
    expect(none.status).toBe(403)
    expect(JSON.parse(none.body)).toEqual({ error: 'Origin not allowed.' })
    const evil = await withCookie(cookie, '/api/agents', { method: 'POST', headers: { ...headers, origin: 'http://evil.example' }, body: newAgent })
    expect(evil.status).toBe(403)
    expect(await agentNames()).not.toContain('Cookie Agent')
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await withCookie(cookie, '/api/agents/agent-demo-backend', { method, headers })).status).toBe(403)
    }
    const ok = await withCookie(cookie, '/api/agents', { method: 'POST', headers: { ...headers, origin: ORIGIN }, body: newAgent })
    expect(ok.status).toBe(201)
    expect(await agentNames()).toContain('Cookie Agent')
  })

  it('leaves bearer mutations without an Origin alone, also when a cookie is sent too', async () => {
    await start()
    const { cookie } = await paired()
    const bearer = await s.api('POST', '/api/agents', { name: 'Bearer Agent', role: 'R', department: 'backend' })
    expect(bearer.status).toBe(201)
    const both = await rawRequest(s.url, { method: 'POST', path: '/api/agents', headers: { ...JSON_TYPE, cookie }, body: JSON.stringify({ name: 'Both Agent', role: 'R', department: 'backend' }) })
    expect(both.status).toBe(201)
  })

  it('treats a bad bearer plus a valid cookie as cookie-only', async () => {
    await start()
    const { cookie } = await paired()
    const r = await rawRequest(s.url, { method: 'POST', path: '/api/agents', noAuth: true, headers: { ...JSON_TYPE, cookie, authorization: 'Bearer wrong' }, body: newAgent })
    expect(r.status).toBe(403)
  })

  it('does not let a hostile Origin read with the cookie either', async () => {
    await start()
    const { cookie } = await paired()
    expect((await withCookie(cookie, '/api/state', { headers: { origin: 'http://evil.example' } })).status).toBe(403)
  })

  it('opens the event stream with the cookie and refuses a bad id', async () => {
    await start()
    const { cookie } = await paired()
    const ok = await openEventStream(s.url, { headers: { cookie, authorization: '' } })
    expect(ok.response.status).toBe(200)
    ok.close()
    const bad = await openEventStream(s.url, { headers: { cookie: 'vo_session=bogus', authorization: '' } })
    expect(bad.response.status).toBe(401)
    bad.close()
  })

  it('DELETE /api/session ends the session and clears the cookie', async () => {
    await start()
    const { cookie } = await paired()
    const noOrigin = await withCookie(cookie, '/api/session', { method: 'DELETE', headers: JSON_TYPE })
    expect(noOrigin.status).toBe(403)
    expect(s.app.sessions.size).toBe(1)
    const r = await withCookie(cookie, '/api/session', { method: 'DELETE', headers: { ...JSON_TYPE, origin: ORIGIN } })
    expect(r.status).toBe(204)
    expect(String(r.headers['set-cookie'])).toBe('vo_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0')
    expect((await withCookie(cookie, '/api/state')).status).toBe(401)
    expect(s.app.sessions.size).toBe(0)
  })

  it('DELETE /api/session needs auth, and works for a bearer client', async () => {
    await start()
    const anon = await rawRequest(s.url, { method: 'DELETE', path: '/api/session', noAuth: true, headers: JSON_TYPE })
    expect(anon.status).toBe(401)
    const bearer = await s.api('DELETE', '/api/session')
    expect(bearer.status).toBe(204)
  })
})

describe('CORS credentials', () => {
  it('adds allow-credentials only with an exact allowed Origin', async () => {
    await start()
    const ok = await rawRequest(s.url, { path: '/api/state', headers: { origin: ORIGIN } })
    expect(ok.headers['access-control-allow-credentials']).toBe('true')
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN)
    const none = await rawRequest(s.url, { path: '/api/state' })
    expect(none.headers['access-control-allow-credentials']).toBeUndefined()
    const evil = await rawRequest(s.url, { path: '/api/state', headers: { origin: 'http://evil.example' } })
    expect(evil.headers['access-control-allow-credentials']).toBeUndefined()
    const pre = await rawRequest(s.url, { method: 'OPTIONS', path: '/api/session', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
    expect(pre.status).toBe(204)
    expect(pre.headers['access-control-allow-credentials']).toBe('true')
    const preEvil = await rawRequest(s.url, { method: 'OPTIONS', path: '/api/session', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } })
    expect(preEvil.headers['access-control-allow-credentials']).toBeUndefined()
    const preNone = await rawRequest(s.url, { method: 'OPTIONS', path: '/api/session' })
    expect(preNone.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

// Note: the recording logger sees post-redaction lines, so the raw audit file text is the strong no-leak check.
describe('audit and logs', () => {
  it('audits created, ended and rejected sessions without the token or the id', async () => {
    await start()
    await pair({ token: 'wrong-secret-guess' })
    const r = await pair({ token: TEST_TOKEN })
    const cookie = cookieOf(r.headers['set-cookie'])
    const id = cookie.replace('vo_session=', '')
    await withCookie(cookie, '/api/state')
    await withCookie(cookie, '/api/session', { method: 'DELETE', headers: { ...JSON_TYPE, origin: ORIGIN } })
    for (let i = 0; i < 10; i++) await pair({ token: `x${i}` })
    await pair({ token: TEST_TOKEN })
    s.app.audit.close()
    const text = auditText()
    const records = text.trim().split('\n').map((l) => JSON.parse(l))
    const actions = records.map((x: { action: string }) => x.action)
    expect(actions).toContain('session.created')
    expect(actions).toContain('session.ended')
    const rejected = records.filter((x: { action: string }) => x.action === 'session.rejected')
    expect(rejected.map((x: { reason: string }) => x.reason)).toEqual(expect.arrayContaining(['bad_token', 'rate_limited']))
    for (const rec of records.filter((x: { action: string }) => x.action.startsWith('session.'))) {
      expect(rec.actor).toBe('api')
      expect(rec.requestId).toMatch(/^[0-9a-f]{12}$/)
    }
    for (const secret of [TEST_TOKEN, id, 'wrong-secret-guess']) {
      expect(text).not.toContain(secret)
      expect(logger.lines.join('\n')).not.toContain(secret)
    }
  })

  it('throttles session.rejected like request.rejected and keeps earlier records', async () => {
    await start()
    await pair({ token: TEST_TOKEN })
    for (let i = 0; i < 10; i++) await pair({ token: `x${i}` })
    for (let i = 0; i < 200; i++) await pair({ token: TEST_TOKEN })
    s.app.audit.close()
    const records = auditText().trim().split('\n').map((l) => JSON.parse(l))
    expect(records.filter((x: { action: string }) => x.action === 'session.created')).toHaveLength(1)
    expect(records.filter((x: { action: string }) => x.action === 'session.rejected').length).toBeLessThanOrEqual(30)
    expect(records.some((x: { reason?: string }) => x.reason === 'suppressed')).toBe(true)
  })
})

describe('review fixes', () => {
  it('clears a stale cookie on DELETE /api/session even though auth fails, with the same 401 body', async () => {
    await start({ ALLOWED_ORIGINS: `${HTTPS_ORIGIN},${ORIGIN}` })
    const r = await withCookie('vo_session=stale', '/api/session', { method: 'DELETE', headers: JSON_TYPE })
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized.' })
    expect(String(r.headers['set-cookie'])).toBe('vo_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0')
    const none = await rawRequest(s.url, { method: 'DELETE', path: '/api/session', noAuth: true, headers: JSON_TYPE })
    expect(none.status).toBe(401)
    expect(none.headers['set-cookie']).toBeUndefined()
    const other = await withCookie('vo_session=stale', '/api/agents/x', { method: 'DELETE', headers: JSON_TYPE })
    expect(other.headers['set-cookie']).toBeUndefined()
    const https = await withCookie('vo_session=stale', '/api/session', { method: 'DELETE', headers: { ...JSON_TYPE, origin: HTTPS_ORIGIN } })
    expect(String(https.headers['set-cookie'])).toBe('vo_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0; Secure')
  })

  it('adds Secure to the clearing cookie for an https Origin', async () => {
    await start({ ALLOWED_ORIGINS: `${HTTPS_ORIGIN},${ORIGIN}` })
    const r = await s.api('DELETE', '/api/session', undefined, { origin: HTTPS_ORIGIN })
    expect(r.status).toBe(204)
    expect(r.headers.get('set-cookie')).toBe('vo_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0; Secure')
  })

  it('refuses cookie-only mutations with a multi-value or trailing-slash Origin', async () => {
    await start()
    const r = await pair({ token: TEST_TOKEN })
    const cookie = cookieOf(r.headers['set-cookie'])
    for (const origin of [`${ORIGIN}, http://evil.example`, `${ORIGIN}/`]) {
      expect((await withCookie(cookie, '/api/agents', { method: 'POST', headers: { ...JSON_TYPE, origin }, body: newAgent })).status).toBe(403)
    }
    expect(await agentNames()).not.toContain('Cookie Agent')
  })

  it('counts non-string tokens toward the limit and sends Retry-After on 429', async () => {
    await start()
    for (let i = 0; i < 10; i++) expect((await pair({ token: i })).status).toBe(401)
    clock += 20_000
    const r = await pair({ token: TEST_TOKEN })
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBe('40')
  })
})
