import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { silentLogger } from '../log'
import { openEventStream } from '../test/sseClient'
import { rawRequest, startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'
import { createSecurityGuards } from './guards'
import { createRouter } from './router'

let s: TestServer
const SLOW = { thinkingMs: 60000, workingMs: 60000 }
beforeEach(async () => { s = await startTestServer({}, { mockTimings: SLOW }) })
afterEach(async () => { await s.close() })

const raw = (path: string, headers: Record<string, string> = {}, extra: { method?: string; body?: string } = {}) => rawRequest(s.url, { path, headers, ...extra })
const JSON_TYPE = { 'content-type': 'application/json' }
const noAcao = (h: Record<string, unknown>) => expect(h['access-control-allow-origin']).toBeUndefined()

describe('Host allowlist (DNS rebinding)', () => {
  it('rejects a foreign Host header', async () => {
    for (const path of ['/api/state', '/api/events']) {
      const r = await raw(path, { host: `evil.example:${s.port}` })
      expect(r.status).toBe(421)
      expect(JSON.parse(r.body)).toEqual({ error: 'Host not allowed.' })
      noAcao(r.headers)
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('accepts loopback names with the server port only', async () => {
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `LOCALHOST:${s.port}`]) expect((await raw('/api/health', { host })).status).toBe(200)
    for (const host of ['localhost', 'localhost:1', `127.0.0.1.:${s.port}`, `127.0.0.1:${s.port}.evil`]) expect((await raw('/api/health', { host })).status).toBe(421)
  })
})

describe('Origin allowlist and CORS', () => {
  it('rejects a disallowed Origin on any method with no CORS headers', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      const r = await raw('/api/state', { origin })
      expect(r.status).toBe(403)
      expect(JSON.parse(r.body)).toEqual({ error: 'Origin not allowed.' })
      noAcao(r.headers)
    }
    const post = await raw('/api/agents', { origin: 'http://evil.example', ...JSON_TYPE }, { method: 'POST', body: JSON.stringify({ name: 'X', role: 'R', department: 'backend' }) })
    expect(post.status).toBe(403)
    expect((await s.api('GET', '/api/state')).body.state.agents.some((a: { name: string }) => a.name === 'X')).toBe(false)
  })

  it('allows the configured origins with exact CORS headers', async () => {
    const r = await raw('/api/state', { origin: 'http://localhost:5173' })
    expect(r.status).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(String(r.headers.vary)).toContain('Origin')
    expect(r.headers['access-control-expose-headers']).toBe('X-Request-Id')
    expect(r.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('answers a preflight for an allowed origin', async () => {
    const r = await raw('/api/agents/agent-demo-backend/tasks', { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173')
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE')
    expect(r.headers['access-control-allow-headers']).toBe('Content-Type, Last-Event-ID')
    expect(r.headers['access-control-max-age']).toBe('600')
    expect(r.body).toBe('')
  })

  it('refuses a preflight from another origin', async () => {
    const r = await raw('/api/agents/agent-demo-backend/tasks', { origin: 'http://evil.example', 'access-control-request-method': 'POST' }, { method: 'OPTIONS' })
    expect(r.status).toBe(403)
    noAcao(r.headers)
  })

  it('answers an OPTIONS request with no Origin by listing the methods', async () => {
    const r = await raw('/api/state', {}, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.allow).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS')
  })

  it('honours a custom ALLOWED_ORIGINS', async () => {
    const t = await startTestServer({ ALLOWED_ORIGINS: 'http://app.local:3000' })
    try {
      const ok = await rawRequest(t.url, { path: '/api/state', headers: { origin: 'http://app.local:3000' } })
      expect(ok.status).toBe(200)
      expect(ok.headers['access-control-allow-origin']).toBe('http://app.local:3000')
      expect((await rawRequest(t.url, { path: '/api/state', headers: { origin: 'http://localhost:5173' } })).status).toBe(403)
    } finally {
      await t.close()
    }
  })
})

describe('JSON-only state changes', () => {
  it('a cross-origin simple POST cannot reach a body-less route', async () => {
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
    const id = started.body.task.id as string
    const evil = await raw(`/api/tasks/${id}/cancel`, { origin: 'http://evil.example', 'content-type': 'text/plain' }, { method: 'POST' })
    expect(evil.status).toBe(403)
    const plain = await raw(`/api/tasks/${id}/cancel`, { 'content-type': 'text/plain' }, { method: 'POST' })
    expect(plain.status).toBe(415)
    expect(JSON.parse(plain.body)).toEqual({ error: 'Content-Type must be application/json.' })
    expect((await raw(`/api/tasks/${id}/cancel`, {}, { method: 'POST' })).status).toBe(415)
    const task = (await s.api('GET', '/api/state')).body.state.tasks[0]
    expect(['starting', 'running']).toContain(task.status)
    expect((await raw(`/api/tasks/${id}/cancel`, JSON_TYPE, { method: 'POST' })).status).toBe(202)
  })

  it('covers DELETE and the demo routes', async () => {
    expect((await raw('/api/agents/agent-demo-qa', {}, { method: 'DELETE' })).status).toBe(415)
    expect((await raw('/api/demo/agents/restore', {}, { method: 'POST' })).status).toBe(415)
    expect((await s.api('GET', '/api/state')).body.state.agents.some((a: { id: string }) => a.id === 'agent-demo-qa')).toBe(true)
  })

  it('GET needs no content type', async () => {
    expect((await raw('/api/state')).status).toBe(200)
  })
})

describe('every reply', () => {
  const hardening = (h: Record<string, unknown>) => {
    expect(h['x-request-id']).toMatch(/^[0-9a-f]{12}$/)
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['cross-origin-resource-policy']).toBe('same-origin')
    expect(h['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(h['x-content-type-options']).toBe('nosniff')
  }

  it('carries a request id and the hardening headers', async () => {
    hardening((await raw('/api/health')).headers)
    hardening((await raw('/api/nope')).headers)
    hardening((await raw('/api/health', { host: 'evil.example' })).headers)
    hardening((await raw('/api/agents', {}, { method: 'POST' })).headers)
    const stream = await openEventStream(s.url)
    try {
      hardening(Object.fromEntries(stream.response.headers.entries()))
    } finally {
      stream.close()
    }
  })
})

describe('onReject', () => {
  let server: Server
  afterEach(async () => { await new Promise((r) => server.close(() => r(null))) })

  it('reports guard rejections with a reason code and no body text', async () => {
    const spy = vi.fn()
    server = createServer(createRouter({ routes: [{ method: 'GET', path: '/api/state', handler: () => ({ status: 200, body: {} }) }], guards: createSecurityGuards({ allowedOrigins: ['http://localhost:5173'], apiToken: TEST_TOKEN, onReject: spy }), log: silentLogger }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await rawRequest(base, { path: '/api/state', headers: { host: 'evil.example' } })
    await rawRequest(base, { path: '/api/state', headers: { origin: 'http://evil.example' } })
    await rawRequest(base, { method: 'POST', path: '/api/state', headers: { 'content-type': 'text/plain' }, body: 'secret-body-text' })
    expect(spy.mock.calls.map(([r]) => r.code)).toEqual(['host', 'origin', 'content_type'])
    expect(spy.mock.calls.every(([r]) => r.path === '/api/state' && typeof r.requestId === 'string')).toBe(true)
    expect(spy.mock.calls[2][0]).toMatchObject({ method: 'POST', status: 415 })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-body-text')
  })
})
