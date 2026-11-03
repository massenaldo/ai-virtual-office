import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../log'
import { openEventStream } from '../test/sseClient'
import { startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'
import { startGateway } from './gateway'

const PASSWORD = 'a-long-test-password'
const BASIC = `Basic ${Buffer.from(`u:${PASSWORD}`).toString('base64')}`
const SAME = { 'sec-fetch-site': 'same-origin' }
const STUB_TOKEN = 'stub-token-should-never-leak'

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }
type Reply = { status: number; headers: IncomingHttpHeaders; body: string }

function call(url: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // The path is sent as given: URL parsing would rewrite '//api' and '..'.
    const u = new URL(url)
    const req = request({ hostname: u.hostname, port: u.port, path: opts.path, method: opts.method ?? 'GET', headers: { ...(opts.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(opts.body)) }), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

let staticDir: string
beforeAll(() => {
  staticDir = mkdtempSync(join(tmpdir(), 'vo-proxy-'))
  writeFileSync(join(staticDir, 'index.html'), '<html>app</html>')
})
afterAll(() => { rmSync(staticDir, { recursive: true, force: true }) })

// A plain upstream that records what it receives, to assert on headers the real backend would hide.
describe('proxy against a stub upstream', () => {
  let stub: Server
  let stubPort: number
  let seen: Seen[]
  let gw: Awaited<ReturnType<typeof startGateway>>
  const log = recordingLogger()
  let token: string | null = STUB_TOKEN

  beforeEach(async () => {
    seen = []
    token = STUB_TOKEN
    stub = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        res.setHeader('content-type', 'application/json')
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    stubPort = (stub.address() as AddressInfo).port
    gw = await startGateway({ password: PASSWORD, staticDir, backend: { host: '127.0.0.1', port: stubPort }, readToken: () => token, log, host: '127.0.0.1', port: 0 })
  })
  afterEach(async () => {
    await gw.close()
    stub.closeAllConnections()
    await new Promise((r) => stub.close(r))
  })

  const viaGateway = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string | Buffer) =>
    call(gw.url, { method, path, headers: { authorization: BASIC, ...SAME, ...headers }, body })

  it('drops the client credentials and forwarding headers, injects the bearer and rewrites Host', async () => {
    const r = await viaGateway('/api/things?a=1&b=2', {
      cookie: 'session=abc', origin: 'https://evil.example', referer: 'https://evil.example/x', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil', forwarded: 'for=1.2.3.4',
      'accept-encoding': 'gzip, br', 'last-event-id': 'boot:7', 'content-type': 'application/json',
    }, 'POST', '{"n":1}')
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    const h = seen[0].headers
    expect(h.authorization).toBe(`Bearer ${STUB_TOKEN}`)
    expect(h.host).toBe(`127.0.0.1:${stubPort}`)
    for (const name of ['cookie', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'sec-fetch-site']) expect(h[name], name).toBeUndefined()
    expect(JSON.stringify(h)).not.toContain(PASSWORD)
    expect(JSON.stringify(h)).not.toContain(BASIC)
    expect(h['accept-encoding']).toBe('identity')
    expect(h['last-event-id']).toBe('boot:7')
    expect(h['content-type']).toBe('application/json')
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/things?a=1&b=2', body: '{"n":1}' })
  })

  it('never puts the backend token in a response or a log line', async () => {
    const ok = await viaGateway('/api/state')
    const refused = await viaGateway('/api/state', { 'sec-fetch-site': 'cross-site' })
    token = null
    const noToken = await viaGateway('/api/state')
    for (const r of [ok, refused, noToken]) expect(JSON.stringify(r.headers) + r.body).not.toContain(STUB_TOKEN)
    expect(log.lines.join('\n')).not.toContain(STUB_TOKEN)
    expect(log.lines.join('\n')).not.toContain(PASSWORD)
  })

  it.each(['GET', 'POST', 'DELETE'])('refuses %s without a same-origin Sec-Fetch-Site and never reaches the backend', async (method) => {
    const cases: Array<Record<string, string>> = [{ 'sec-fetch-site': '' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }]
    for (const headers of cases) {
      for (const path of ['/api/state', '/api/events']) {
        const h: Record<string, string> = { authorization: BASIC, 'content-type': 'application/json', ...headers }
        if (headers['sec-fetch-site'] === '') delete h['sec-fetch-site']
        const r = await call(gw.url, { method, path, headers: h, body: method === 'GET' ? undefined : '{}' })
        expect(r.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403)
        expect(JSON.parse(r.body)).toEqual({ error: 'The gateway only serves requests from this app.' })
        expect(r.headers['cache-control']).toBe('no-store')
      }
    }
    expect(seen).toEqual([])
  })

  it.each(['/API/state', '/%61pi/state', '//api/state', '/api/../x', '/api%2Fstate', '/apiX'])('answers 404 for %s and never forwards it', async (path) => {
    const r = await viaGateway(path)
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body)).toEqual({ error: 'Not found.' })
    expect(seen).toEqual([])
  })

  it('needs the password for every one of these', async () => {
    for (const path of ['/api/state', '/api/events', '/API/state']) {
      for (const headers of [{ ...SAME }, { ...SAME, authorization: `Basic ${Buffer.from('u:wrong-password-1').toString('base64')}` }]) {
        expect((await call(gw.url, { path, headers })).status, path).toBe(401)
      }
    }
    expect(seen).toEqual([])
  })

  it('answers 503 when the token is not available', async () => {
    token = null
    const r = await viaGateway('/api/state')
    expect(r.status).toBe(503)
    expect(JSON.parse(r.body)).toEqual({ error: 'The backend token is not available. Is the backend running?' })
    expect(seen).toEqual([])
  })

  it('answers 413 for a body over 1 MiB, declared or not, and forwards nothing', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 'a')
    const declared = await viaGateway('/api/agents', { 'content-type': 'application/json' }, 'POST', big)
    expect(declared.status).toBe(413)
    expect(JSON.parse(declared.body)).toEqual({ error: 'The request body is too large.' })
    // No Content-Length: sent chunked.
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: new URL(gw.url).port, path: '/api/agents', method: 'POST', headers: { authorization: BASIC, ...SAME, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.write(big.subarray(0, 600_000))
      req.write(big.subarray(600_000))
      req.end()
    })
    expect(chunked).toBe(413)
    expect(seen).toEqual([])
    expect((await viaGateway('/api/agents', { 'content-type': 'application/json' }, 'POST', Buffer.alloc(1024 * 1024, 'a'))).status).toBe(200)
  })

  it('answers 502 with a fixed sentence when the backend is not reachable', async () => {
    stub.closeAllConnections()
    await new Promise((r) => stub.close(r))
    const r = await viaGateway('/api/state')
    expect(r.status).toBe(502)
    expect(JSON.parse(r.body)).toEqual({ error: 'The backend is not reachable.' })
    expect(r.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/)
    stub = createServer()
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  })

  it('still serves the app and keeps no-store on /api answers', async () => {
    expect((await call(gw.url, { path: '/', headers: { authorization: BASIC } })).body).toBe('<html>app</html>')
    expect((await viaGateway('/api/state')).headers['cache-control']).toBe('no-store')
  })
})

describe('streaming through the proxy', () => {
  let stub: Server
  let gw: Awaited<ReturnType<typeof startGateway>>
  let release: () => void
  let upstreamClosed: Promise<void>
  let mode: 'hold' | 'cut' = 'hold'

  beforeEach(async () => {
    mode = 'hold'
    let closed!: () => void
    upstreamClosed = new Promise((r) => { closed = r })
    stub = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: {"n":1}\n\n')
      req.on('close', closed)
      res.on('close', closed)
      if (mode === 'cut') setTimeout(() => res.socket?.destroy(), 20)
      else release = () => res.end()
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    gw = await startGateway({ password: PASSWORD, staticDir, backend: { host: '127.0.0.1', port: (stub.address() as AddressInfo).port }, readToken: () => 't', log: recordingLogger(), host: '127.0.0.1', port: 0 })
  })
  afterEach(async () => {
    await gw.close()
    stub.closeAllConnections()
    await new Promise((r) => stub.close(r))
  })

  it('delivers the first chunk while the upstream is still open, with stream headers, and closes the upstream when the client leaves', async () => {
    const abort = new AbortController()
    const res = await fetch(`${gw.url}/api/events`, { headers: { authorization: BASIC, ...SAME }, signal: abort.signal })
    // Headers and the first frame arrive although the upstream response never ends.
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('data: {"n":1}\n\n')
    let settled = false
    void upstreamClosed.then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
    abort.abort()
    await Promise.race([upstreamClosed, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream stayed open')), 2000))])
    release()
  })

  it('drops the client when the upstream dies mid-stream', async () => {
    mode = 'cut'
    const res = await fetch(`${gw.url}/api/events`, { headers: { authorization: BASIC, ...SAME } })
    const reader = res.body!.getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow()
  })
})

describe('proxy against the real backend', () => {
  let server: TestServer
  let gw: Awaited<ReturnType<typeof startGateway>>
  const log = recordingLogger()

  beforeAll(async () => {
    server = await startTestServer()
    gw = await startGateway({ password: PASSWORD, staticDir, backend: { host: '127.0.0.1', port: Number(new URL(server.url).port) }, readToken: () => server.app.apiToken.value, log, host: '127.0.0.1', port: 0 })
  })
  afterAll(async () => {
    await gw.close()
    await server.close()
  })

  const headers = { authorization: BASIC, ...SAME }
  const waitFor = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('condition not met in time')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('serves GET /api/state and POST /api/agents with only the password', async () => {
    const state = await call(gw.url, { path: '/api/state', headers })
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body).state.agents).toBeDefined()
    expect(JSON.stringify(state.headers) + state.body).not.toContain(TEST_TOKEN)
    const created = await call(gw.url, { method: 'POST', path: '/api/agents', headers: { ...headers, 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Gate', role: 'Tester', department: 'backend' }) })
    expect(created.status).toBe(201)
    expect(log.lines.join('\n')).not.toContain(TEST_TOKEN)
  })

  it('refuses the backend directly without its token, proving the gateway is what supplies it', async () => {
    expect((await call(server.url, { path: '/api/state' })).status).toBe(401)
  })

  it('delivers an event within a second, replays from Last-Event-ID, and closes the upstream when the client leaves', async () => {
    const base = server.app.streams.size
    const stream = await openEventStream(gw.url, { headers })
    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
    await waitFor(() => server.app.streams.size === base + 1)
    const before = (await server.api('GET', '/api/state')).body.lastEventId as string
    const started = Date.now()
    expect((await server.api('POST', '/api/agents', { name: 'Live', role: 'Streamer', department: 'backend' })).status).toBe(201)
    const live = await stream.next((e) => e.type === 'state.changed', 1000)
    expect(live.type).toBe('state.changed')
    expect(Date.now() - started).toBeLessThan(1000)
    stream.close()
    await waitFor(() => server.app.streams.size === base)

    const resumed = await openEventStream(gw.url, { headers: { ...headers, 'Last-Event-ID': before } })
    try {
      const replayed = await resumed.next((e) => e.type === 'state.changed')
      expect(replayed.id).toBe(live.id)
    } finally {
      resumed.close()
    }
    const viaQuery = await openEventStream(gw.url, { headers, query: `?lastEventId=${encodeURIComponent(before)}` })
    try {
      expect((await viaQuery.next((e) => e.type === 'state.changed')).id).toBe(live.id)
    } finally {
      viaQuery.close()
    }
    await waitFor(() => server.app.streams.size === base)
  })
})
