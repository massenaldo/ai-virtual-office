import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../log'
import { startGateway } from './gateway'

const PASSWORD = 'a-long-test-password'
const auth = (pass = PASSWORD) => ({ authorization: `Basic ${Buffer.from(`u:${pass}`).toString('base64')}` })

let dir: string
let gw: Awaited<ReturnType<typeof startGateway>>
let clock = 0
const log = recordingLogger()

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vo-gw-'))
  writeFileSync(join(dir, 'index.html'), '<html>app</html>')
  writeFileSync(join(dir, 'app.js'), 'x')
})

// A fresh gateway per test: failed attempts are counted globally, so tests must not share the throttle.
beforeEach(async () => {
  clock = 0
  gw = await startGateway({ password: PASSWORD, staticDir: dir, backend: { host: '127.0.0.1', port: 1 }, readToken: () => 'tok', now: () => clock, log, host: '127.0.0.1', port: 0 })
})

afterEach(async () => { await gw.close() })

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => fetch(`${gw.url}${path}`, { method, headers })

describe('gateway', () => {
  it('asks for a password before serving anything', async () => {
    for (const path of ['/', '/app.js', '/api/health', '/api/events', '/missing', '/apiX', '/%61pi/x']) {
      const res = await get(path)
      expect(res.status, path).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Basic realm="Virtual Office", charset="UTF-8"')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).not.toContain('app')
    }
  })

  it('checks the password before the method too', async () => {
    expect((await get('/', {}, 'POST')).status).toBe(401)
  })

  it('serves static files with the password', async () => {
    const res = await get('/', auth())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>app</html>')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await get('/app.js', auth())).status).toBe(200)
    expect((await get('/', auth(), 'HEAD')).status).toBe(200)
    expect((await get('/', auth(), 'POST')).status).toBe(405)
  })

  it('hands /api paths to the proxy after the password check, including variants', async () => {
    // Port 1 has no backend: a plain API path with the right header reaches the proxy and finds it unreachable.
    const plain = await get('/api/health', { ...auth(), 'sec-fetch-site': 'same-origin' })
    expect(plain.status).toBe(502)
    expect(await plain.json()).toEqual({ error: 'The backend is not reachable.' })
    expect((await get('/api/health', auth())).status).toBe(403)
    for (const path of ['/API/x', '/api', '/apiX', '/api%2Fx']) {
      const res = await get(path, { ...auth(), 'sec-fetch-site': 'same-origin' })
      expect(res.status, path).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('never reflects the password or the Authorization header', async () => {
    const res = await get('/', auth())
    const text = JSON.stringify([...res.headers.entries()]) + (await res.text())
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain(auth().authorization)
    const bad = await get('/', auth('wrong-password-xyz'))
    expect(JSON.stringify([...bad.headers.entries()]) + (await bad.text())).not.toContain('wrong-password-xyz')
  })

  it('throttles with 429 and Retry-After, then recovers, and logs no secrets', async () => {
    for (let i = 0; i < 8; i++) expect((await get('/', auth('wrong-password-xyz'))).status).toBe(401)
    const locked = await get('/', auth())
    expect(locked.status).toBe(429)
    expect(locked.headers.get('retry-after')).toBe('300')
    expect(locked.headers.get('cache-control')).toBe('no-store')
    clock += 300_000
    expect((await get('/', auth())).status).toBe(200)
    const logged = log.lines.join('\n')
    expect(logged).not.toContain(PASSWORD)
    expect(logged).not.toContain('wrong-password-xyz')
    expect(logged).not.toContain(Buffer.from(`u:${PASSWORD}`).toString('base64'))
  })

  it('logs every new lock, not only the first', async () => {
    const before = log.lines.filter((l) => l.includes('Too many wrong passwords')).length
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 8; i++) await get('/', auth('wrong-password-xyz'))
      expect((await get('/', auth())).status).toBe(429)
      clock += 300_000
    }
    expect(log.lines.filter((l) => l.includes('Too many wrong passwords')).length - before).toBe(2)
  })

  it('does not lock out on header-less requests', async () => {
    for (let i = 0; i < 20; i++) expect((await get('/')).status).toBe(401)
    expect((await get('/', auth())).status).toBe(200)
  })
})

describe('gateway security headers', () => {
  let stub: Server
  let g: Awaited<ReturnType<typeof startGateway>>
  const expectHeaders = (res: Response, label: string) => {
    expect(res.headers.get('x-frame-options'), label).toBe('DENY')
    expect(res.headers.get('content-security-policy'), label).toBe("frame-ancestors 'none'")
    expect(res.headers.get('referrer-policy'), label).toBe('no-referrer')
  }

  beforeEach(async () => {
    stub = createServer((req, res) => {
      // A backend that tries to loosen them must not win.
      const loosen = { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': 'frame-ancestors *', 'referrer-policy': 'unsafe-url' }
      if (req.url === '/api/events') {
        res.writeHead(200, { ...loosen, 'content-type': 'text/event-stream' })
        res.write(': hi\n\n')
        return
      }
      res.writeHead(200, { ...loosen, 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
    const port = (stub.address() as import('node:net').AddressInfo).port
    g = await startGateway({ password: PASSWORD, staticDir: dir, backend: { host: '127.0.0.1', port }, readToken: () => 'tok', log, host: '127.0.0.1', port: 0 })
  })

  afterEach(async () => {
    await g.close()
    stub.closeAllConnections()
    await new Promise<void>((r) => stub.close(() => r()))
  })

  const call = (path: string, headers: Record<string, string> = {}, method = 'GET') => fetch(`${g.url}${path}`, { method, headers })

  it('sets them on every kind of response', async () => {
    const api = { ...auth(), 'sec-fetch-site': 'same-origin' }
    expectHeaders(await call('/'), '401')
    expectHeaders(await call('/', auth()), 'static')
    expectHeaders(await call('/nope.txt', auth()), 'static 404')
    expectHeaders(await call('/', auth(), 'POST'), '405')
    expectHeaders(await call('/apiX', api), 'api variant 404')
    const proxied = await call('/api/state', api)
    expect(proxied.status).toBe(200)
    expectHeaders(proxied, 'proxied api')
    const sse = await call('/api/events', api)
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    expectHeaders(sse, 'event stream')
    await sse.body?.cancel()
  })
})
