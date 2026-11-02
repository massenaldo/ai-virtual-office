import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../app'
import { AUDIT_FILE } from '../audit'
import { TOKEN_FILE } from '../auth'
import { parseConfig } from '../config'
import { silentLogger } from '../log'
import { openEventStream, type SseStream } from '../test/sseClient'
import { tempDataDir } from '../test/helpers'

// The browser session flow over a real socket: pairing, cookie-only requests and streams, CSRF guard, logout, restart.
// These are the cross-component checks; route-level cases live in server/http/sessionRoutes.test.ts.

const ORIGIN = 'http://localhost:5173'
let dataDir: string
let server: RunningServer
let token: string
const streams: SseStream[] = []

const boot = async () => {
  const parsed = parseConfig({ PORT: '0', DATA_DIR: dataDir })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return startServer(parsed.config, { log: silentLogger })
}
beforeAll(async () => {
  dataDir = tempDataDir()
  server = await boot()
  token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
})
afterAll(async () => {
  streams.splice(0).forEach((x) => x.close())
  await server.close()
})

type Reply = { status: number; body: any; headers: Headers }
async function call(method: string, path: string, opts: { body?: unknown; bearer?: boolean; cookie?: string; origin?: string; base?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['content-type'] = 'application/json'
  if (opts.bearer) headers.authorization = `Bearer ${token}`
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.origin) headers.origin = opts.origin
  const res = await fetch(`${opts.base ?? server.url}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let body: unknown = text
  try { body = text === '' ? null : JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers }
}
const pair = async (base?: string) => {
  const r = await call('POST', '/api/session', { body: { token }, origin: ORIGIN, base })
  const setCookie = r.headers.get('set-cookie') ?? ''
  return { r, setCookie, cookie: setCookie.split(';')[0] }
}
const agentCount = async () => (await call('GET', '/api/state', { bearer: true })).body.state.agents.length as number
const newAgent = { name: 'Nova', role: 'Researcher', department: 'backend' }

describe('browser session, real server', () => {
  it('serves the health check with no credentials at all', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200)
    expect((await call('GET', '/api/state')).status).toBe(401)
  })

  it('pairs once, then state and the event stream work with only the cookie', async () => {
    const { r, cookie } = await pair()
    expect(r.status).toBe(200)
    expect(cookie).toMatch(/^vo_session=[\w-]{20,}$/)
    expect((await call('GET', '/api/state', { cookie })).status).toBe(200)
    const s = await openEventStream(server.url, { headers: { cookie, authorization: '' } })
    streams.push(s)
    // authorization is blanked above, so only the cookie can have authenticated this stream.
    expect(s.response.status).toBe(200)
    // Proof the stream is live and authenticated: a cookie-only mutation shows up on it.
    expect((await call('POST', '/api/agents', { cookie, origin: ORIGIN, body: { ...newAgent, name: 'Via cookie' } })).status).toBe(201)
    expect((await s.next(undefined, 3000)).type).toBeTruthy()
  })

  it('lets a cookie-authenticated mutation through only with an allowed Origin', async () => {
    const { cookie } = await pair()
    const before = await agentCount()
    expect((await call('POST', '/api/agents', { cookie, body: newAgent })).status).toBe(403)
    expect((await call('POST', '/api/agents', { cookie, origin: 'http://evil.example', body: newAgent })).status).toBe(403)
    expect(await agentCount()).toBe(before)
    expect((await call('POST', '/api/agents', { cookie, origin: ORIGIN, body: newAgent })).status).toBe(201)
    expect(await agentCount()).toBe(before + 1)
  })

  it('logout invalidates the cookie for new requests and streams; an already-open stream is not cut', async () => {
    const { cookie } = await pair()
    const open = await openEventStream(server.url, { headers: { cookie, authorization: '' } })
    streams.push(open)
    expect(open.response.status).toBe(200)

    expect((await call('DELETE', '/api/session', { cookie })).status).toBe(403) // cookie-authenticated, so Origin is required
    const out = await call('DELETE', '/api/session', { cookie, origin: ORIGIN })
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)

    expect((await call('GET', '/api/state', { cookie })).status).toBe(401)
    expect((await fetch(`${server.url}/api/events`, { headers: { cookie } })).status).toBe(401)
    expect((await call('POST', '/api/agents', { cookie, origin: ORIGIN, body: newAgent })).status).toBe(401)

    // FINDING: authentication happens once, when the stream is opened. A stream opened before logout keeps receiving events
    // afterwards (until the client disconnects or the server closes). Asserted here as the actual behaviour.
    expect((await call('POST', '/api/agents', { bearer: true, body: { ...newAgent, name: 'After' } })).status).toBe(201)
    const seen = await open.until((e) => JSON.stringify(e).includes('After'), 3000)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('has no Domain attribute on the cookie; the server itself does not bind a session to a hostname', async () => {
    const { setCookie, cookie } = await pair()
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).not.toMatch(/domain=/i)
    // NOTE: browsers, not this server, keep a host-only cookie from localhost away from 127.0.0.1. This only shows the server
    // does no host binding of its own: the same cookie value sent by hand to the other hostname form is accepted.
    for (const host of ['localhost', '127.0.0.1']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: server.port, path: '/api/state', headers: { host: `${host}:${server.port}`, cookie } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(200)
    }
  })

  it('refuses pairing from a hostile Origin with no cookie, and a wrong token with none either', async () => {
    const r = await call('POST', '/api/session', { body: { token }, origin: 'http://evil.example' })
    expect(r.status).toBe(403)
    expect(r.headers.get('set-cookie')).toBeNull()
    const bad = await call('POST', '/api/session', { body: { token: 'nope' }, origin: ORIGIN })
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toBeNull()
  })

  it('writes session.created and session.ended to the audit log without the token or the session id', async () => {
    const { cookie } = await pair()
    await call('DELETE', '/api/session', { cookie, origin: ORIGIN })
    const text = readFileSync(join(dataDir, AUDIT_FILE), 'utf8')
    const actions = text.trim().split('\n').map((l) => JSON.parse(l).action)
    expect(actions).toContain('session.created')
    expect(actions).toContain('session.ended')
    expect(text).not.toContain(token)
    expect(text).not.toContain(cookie.slice('vo_session='.length))
  })

  it('forgets every session when the server restarts on the same data folder', async () => {
    const { cookie } = await pair()
    expect((await call('GET', '/api/state', { cookie })).status).toBe(200)
    streams.splice(0).forEach((x) => x.close())
    await server.close()
    server = await boot()
    // The token is regenerated on each start (not persisted), so the old bearer is stale too; the point is the old cookie is refused.
    token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
    expect((await call('GET', '/api/state', { cookie })).status).toBe(401)
    expect((await call('GET', '/api/state', { bearer: true })).status).toBe(200)
  })
})
