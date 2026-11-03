import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('answers any /api path 502 until the proxy is connected, including variants', async () => {
    for (const path of ['/api/health', '/api/anything?x=1']) {
      const res = await get(path, auth())
      expect(res.status, path).toBe(502)
      expect(await res.json()).toEqual({ error: 'The API is not connected.' })
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    for (const path of ['/API/x', '/api', '/apiX', '/api%2Fx']) {
      const res = await get(path, auth())
      expect(res.status, path).toBe(502)
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
})
