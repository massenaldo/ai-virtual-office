import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE } from './audit'
import { MIN_TOKEN_CHARS, resolveApiToken, TOKEN_FILE, tokenMatches } from './auth'
import { parseConfig } from './config'
import { recordingLogger } from './log'
import { rawRequest, startTestServer, tempDataDir, TEST_TOKEN, type TestServer } from './test/helpers'
import { startServer } from './app'
import { silentLogger } from './log'

let s: TestServer | null = null
afterEach(async () => { await s?.close(); s = null })

const anon = (path: string, extra: { method?: string; headers?: Record<string, string>; body?: string } = {}) => rawRequest(s!.url, { path, noAuth: true, ...extra })
const JSON_HEADERS = { 'content-type': 'application/json' }

describe('the API token guard', () => {
  it.each([
    ['GET', '/api/state'],
    ['GET', '/api/workspaces'],
    ['GET', '/api/events'],
    ['POST', '/api/agents'],
    ['PATCH', '/api/agents/agent-demo-pm'],
    ['DELETE', '/api/agents/agent-demo-pm'],
    ['POST', '/api/tasks/t1/cancel'],
    ['GET', '/api/nope'],
  ])('%s %s needs the token, with no Origin header too', async (method, path) => {
    s = await startTestServer()
    const headers: Record<string, string> = method === 'GET' ? {} : JSON_HEADERS
    const attempts: Array<Record<string, string>> = [{}, { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' }, { authorization: 'Basic abc' }, { authorization: TEST_TOKEN }]
    for (const extra of attempts) {
      const r = await anon(path, { method, headers: { ...headers, ...extra }, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined })
      expect(r.status).toBe(401)
      expect(r.headers['www-authenticate']).toBe('Bearer')
      expect(JSON.parse(r.body)).toEqual({ error: 'Unauthorized.' })
    }
  })

  it('answers the event stream with a 401 and no stream bytes', async () => {
    s = await startTestServer()
    const r = await anon('/api/events')
    expect(r.status).toBe(401)
    expect(r.headers['content-type']).toContain('application/json')
  })

  it('ignores a token in the query string', async () => {
    s = await startTestServer()
    expect((await anon(`/api/state?token=${TEST_TOKEN}`)).status).toBe(401)
    expect((await anon(`/api/events?token=${TEST_TOKEN}&access_token=${TEST_TOKEN}`)).status).toBe(401)
  })

  it('accepts the right token on a request with and without an allowed Origin', async () => {
    s = await startTestServer()
    expect((await rawRequest(s.url, { path: '/api/state' })).status).toBe(200)
    expect((await rawRequest(s.url, { path: '/api/state', headers: { origin: 'http://localhost:5173' } })).status).toBe(200)
    expect((await rawRequest(s.url, { path: '/api/state', headers: { authorization: `bearer ${TEST_TOKEN}` }, noAuth: true })).status).toBe(200)
  })

  it('leaves only the health check and preflight open', async () => {
    s = await startTestServer()
    expect((await anon('/api/health')).status).toBe(200)
    expect((await anon('/api/state', { method: 'OPTIONS' })).status).toBe(204)
    expect((await anon('/api/state', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } })).status).toBe(204)
    const health = JSON.parse((await anon('/api/health')).body)
    expect(Object.keys(health).sort()).toEqual(['audit', 'available', 'credentialsConfigured', 'ok', 'persistence', 'reason', 'runtime', 'startedAt', 'version'])
  })

  it('keeps Host and Origin checks ahead of the token check', async () => {
    s = await startTestServer()
    expect((await anon('/api/state', { headers: { host: 'evil.example' } })).status).toBe(421)
    expect((await anon('/api/state', { headers: { origin: 'http://evil.example' } })).status).toBe(403)
  })

  it('audits a refusal with the reason and without the token', async () => {
    s = await startTestServer()
    await anon('/api/state', { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' } })
    const records = readFileSync(join(s.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(records.find((r) => r.action === 'request.rejected')).toMatchObject({ reason: 'auth', detail: 'GET /api/state' })
  })
})

describe('where the token comes from', () => {
  it('generates one at start, stores it with mode 0600, and makes a new one after a restart', async () => {
    const dataDir = tempDataDir()
    const run = async () => {
      const parsed = parseConfig({ PORT: '0', DATA_DIR: dataDir })
      if (!parsed.ok) throw new Error(parsed.errors.join('; '))
      const server = await startServer(parsed.config, { log: silentLogger })
      const value = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
      const mode = statSync(join(dataDir, TOKEN_FILE)).mode & 0o777
      const ok = (await rawRequest(server.url, { path: '/api/state', token: value })).status
      await server.close()
      return { value, mode, ok }
    }
    const first = await run()
    const second = await run()
    expect(first.mode).toBe(0o600)
    expect(first.value.length).toBeGreaterThanOrEqual(MIN_TOKEN_CHARS)
    expect(first.value).toMatch(/^[A-Za-z0-9_-]+$/)
    expect([first.ok, second.ok]).toEqual([200, 200])
    expect(second.value).not.toBe(first.value)
  })

  it('does not follow or reuse a pre-existing temporary file when writing the token', () => {
    const dir = tempDataDir()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(dir, `${TOKEN_FILE}.tmp`))
    const token = resolveApiToken({ configured: null, dataDir: dir })
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(readFileSync(join(dir, TOKEN_FILE), 'utf8').trim()).toBe(token.value)
    expect(statSync(join(dir, TOKEN_FILE)).mode & 0o777).toBe(0o600)
  })

  it('uses a configured API_TOKEN and does not write it to disk', async () => {
    s = await startTestServer({ API_TOKEN: 'configured-token-0123456789-abcdefghijklmnop' })
    expect((await rawRequest(s.url, { path: '/api/state', token: 'configured-token-0123456789-abcdefghijklmnop' })).status).toBe(200)
    expect((await rawRequest(s.url, { path: '/api/state', token: TEST_TOKEN })).status).toBe(401)
    expect(() => statSync(join(s!.dataDir, TOKEN_FILE))).toThrow()
  })

  it('refuses a short or spaced API_TOKEN and a frontend-style name', () => {
    const bad = (env: Record<string, string>) => { const r = parseConfig({ DATA_DIR: tempDataDir(), ...env }); return r.ok ? [] : r.errors }
    expect(bad({ API_TOKEN: 'short' })).toEqual([`API_TOKEN must be at least ${MIN_TOKEN_CHARS} characters with no spaces.`])
    expect(bad({ API_TOKEN: `${'a'.repeat(20)} ${'b'.repeat(20)}` })).toHaveLength(1)
    for (const name of ['VITE_API_TOKEN', 'VITE_WORKFORCE_TOKEN', 'VITE_SECRET_KEY']) expect(bad({ [name]: 'x' })).toEqual([`${name} is a frontend variable name; the API token must stay on the server. Remove it.`])
    expect(bad({ VITE_WORKFORCE_API_URL: 'http://127.0.0.1:8787' })).toEqual([])
  })
})

describe('the token never leaks', () => {
  it('is in no log line, audit record, response body or header', async () => {
    const rec = recordingLogger()
    s = await startTestServer({}, { log: rec, mockTimings: { thinkingMs: 20, workingMs: 20 } })
    const seen: string[] = []
    const keep = (r: { status: number; headers: unknown; body: unknown }) => seen.push(JSON.stringify(r))
    keep(await s.api('GET', '/api/state'))
    keep(await s.api('GET', '/api/health'))
    keep(await s.api('POST', '/api/agents/agent-demo-pm/tasks', { title: 'x' }))
    keep(await s.api('GET', '/api/state', undefined, { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' }))
    keep(await s.api('POST', '/api/agents', { name: 5 }, { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' }))
    seen.push(JSON.stringify(await rawRequest(s.url, { path: '/api/state', noAuth: true })))
    await new Promise((r) => setTimeout(r, 100))
    seen.push(readFileSync(join(s.dataDir, AUDIT_FILE), 'utf8'), readFileSync(join(s.dataDir, 'workforce.json'), 'utf8'), rec.lines.join('\n'))
    for (const text of seen) expect(text).not.toContain(TEST_TOKEN)
    expect(readFileSync(join(s.dataDir, AUDIT_FILE), 'utf8')).toContain('auth=configured')
  })
})

describe('tokenMatches', () => {
  const T = 'a-token-that-is-long-enough-0123456789'
  it('accepts only a Bearer header with the exact value', () => {
    expect(tokenMatches(T, `Bearer ${T}`)).toBe(true)
    expect(tokenMatches(T, `bearer ${T}`)).toBe(true)
    for (const header of [undefined, '', T, `Bearer ${T}x`, `Bearer ${T.slice(1)}`, `Bearer  ${T}`, `Basic ${T}`, `Bearer ${T} extra`]) expect(tokenMatches(T, header)).toBe(false)
  })
})
