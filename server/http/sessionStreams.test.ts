import { afterEach, describe, expect, it } from 'vitest'
import { openEventStream, type SseStream } from '../test/sseClient'
import { rawRequest, startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'

// Event streams are authenticated once, at open. A stream opened with only a session cookie must end when that session ends
// (logout, eviction, expiry); a bearer stream has no session and is never cut by one.

const ORIGIN = 'http://localhost:5173'
let s: TestServer
let clock = Date.parse('2026-11-02T10:00:00.000Z')
const open: SseStream[] = []
afterEach(async () => { open.splice(0).forEach((x) => x.close()); await s.close() })

async function start(heartbeatMs = 15000) {
  clock = Date.parse('2026-11-02T10:00:00.000Z')
  s = await startTestServer({}, { mockTimings: { thinkingMs: 60000, workingMs: 60000 }, now: () => new Date(clock).toISOString(), heartbeatMs })
}
async function pairCookie(): Promise<string> {
  const r = await rawRequest(s.url, { method: 'POST', path: '/api/session', noAuth: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TEST_TOKEN }) })
  return String(r.headers['set-cookie']).split(';')[0]
}
async function cookieStream(cookie: string) {
  const st = await openEventStream(s.url, { headers: { cookie, authorization: '' } })
  open.push(st)
  expect(st.response.status).toBe(200)
  return st
}
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const logout = (cookie: string) => rawRequest(s.url, { method: 'DELETE', path: '/api/session', noAuth: true, headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } })

describe('event streams tied to a session', () => {
  it('logout closes the cookie stream immediately', async () => {
    await start()
    const cookie = await pairCookie()
    await cookieStream(cookie)
    expect(s.app.streams.size).toBe(1)
    expect((await logout(cookie)).status).toBe(204)
    expect(s.app.streams.size).toBe(0)
  })

  it('a bearer stream and another session stream survive a logout', async () => {
    await start()
    const a = await pairCookie()
    const b = await pairCookie()
    await cookieStream(a)
    await cookieStream(b)
    const bearer = await openEventStream(s.url)
    open.push(bearer)
    expect(s.app.streams.size).toBe(3)
    await logout(a)
    expect(s.app.streams.size).toBe(2)
    expect((await s.api('POST', '/api/agents', { name: 'Still Here', role: 'R', department: 'backend' })).status).toBe(201)
    await bearer.until((e) => JSON.stringify(e).includes('Still Here'))
  })

  it('a stream with a valid bearer plus a cookie is a bearer stream', async () => {
    await start()
    const cookie = await pairCookie()
    const both = await openEventStream(s.url, { headers: { cookie } })
    open.push(both)
    await logout(cookie)
    expect(s.app.streams.size).toBe(1)
  })

  it('the heartbeat ends a cookie stream once its session has expired, using the injected clock', async () => {
    await start(30)
    const cookie = await pairCookie()
    const bearer = await openEventStream(s.url)
    open.push(bearer)
    await cookieStream(cookie)
    expect(s.app.streams.size).toBe(2)
    await new Promise((r) => setTimeout(r, 100))
    expect(s.app.streams.size).toBe(2)
    clock += 28_800_000
    await until(() => s.app.streams.size === 1)
  })

  it('evicting the oldest session closes its stream', async () => {
    await start()
    const first = await pairCookie()
    await cookieStream(first)
    for (let i = 0; i < 19; i++) await pairCookie()
    expect(s.app.streams.size).toBe(1)
    await pairCookie()
    expect(s.app.sessions.size).toBe(20)
    expect(s.app.streams.size).toBe(0)
  })
})
