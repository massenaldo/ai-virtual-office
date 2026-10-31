import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { startServer, type RunningServer } from '../server/app'
import { AUDIT_FILE } from '../server/audit'
import { TOKEN_FILE } from '../server/auth'
import { parseConfig } from '../server/config'
import { silentLogger } from '../server/log'
import { tempDataDir } from '../server/test/helpers'
import { openEventStream, type SseStream } from '../server/test/sseClient'

// The browser's real path in backend mode: a real Vite dev server (with the gate and the proxy from vite.config.ts) in
// front of the real backend, with a real event stream through it. Nothing is faked.

let backend: RunningServer
let vite: ViteDevServer
let viteUrl = ''
let dataDir = ''
let token = ''
const saved: Record<string, string | undefined> = {}
const streams: SseStream[] = []
const bodies: string[] = []

type Reply = { status: number; headers: Record<string, unknown>; body: string }
const call = (method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> =>
  new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port: new URL(viteUrl).port, method, path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const reply = { status: res.statusCode ?? 0, headers: res.headers as Record<string, unknown>, body: Buffer.concat(chunks).toString('utf8') }
        bodies.push(`${reply.body}\n${JSON.stringify(reply.headers)}`)
        done(reply)
      })
    })
    req.on('error', fail)
    req.end(opts.body)
  })
const SAME = { 'sec-fetch-site': 'same-origin' }
const JSON_SAME = { ...SAME, 'content-type': 'application/json' }

beforeAll(async () => {
  dataDir = tempDataDir()
  const parsed = parseConfig({ PORT: '0', DATA_DIR: dataDir })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  backend = await startServer(parsed.config, { log: silentLogger, heartbeatMs: 100, mockTimings: { thinkingMs: 50, workingMs: 60000 } })
  token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
  for (const [k, v] of Object.entries({ VITE_WORKFORCE_API_URL: '/', PORT: String(backend.port), DATA_DIR: resolve(dataDir), API_TOKEN: undefined })) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vite = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'silent', server: { port: 0, strictPort: false } })
  await vite.listen()
  viteUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
})
afterAll(async () => {
  streams.splice(0).forEach((s) => s.close())
  await vite?.close()
  await backend?.close()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const stream = async (opts: { lastEventId?: string } = {}) => {
  const base = { headers: SAME, token: 'attacker-token-attacker-token-attacker-0000' }
  const url = new URL(viteUrl)
  const s = await openEventStream(`http://${url.host}`, { ...base, ...opts })
  streams.push(s)
  return s
}

describe('Vite dev server → proxy → backend', () => {
  it('serves a same-origin request with the token the page never sees', async () => {
    const ok = await call('GET', '/api/state', { headers: SAME })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).state.agents.length).toBeGreaterThan(0)
  })

  it('refuses what the browser does not mark same-origin, and replaces a caller-supplied token', async () => {
    expect((await call('GET', '/api/state')).status).toBe(403)
    expect((await call('GET', '/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call('GET', '/api/state', { headers: { ...SAME, authorization: 'Bearer attacker-token-attacker-token-attacker-0000', cookie: 'a=b' } })).status).toBe(200)
  })

  it('answers every variant of the prefix without reaching the backend', async () => {
    for (const path of ['/api', '/apiX', '/API/state', '/%61pi/state', '/api%2Fstate', '//api/state', '/api/../x']) {
      const r = await call('GET', path, { headers: SAME })
      expect(r.status, path).not.toBe(200)
      expect(r.status, path).toBeLessThan(500)
    }
    const audit = readFileSync(join(dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(audit.filter((r) => r.action === 'request.rejected' && r.reason === 'auth')).toEqual([])
  })

  it('carries the event stream: events for a task created through Vite, a heartbeat, and a resume', async () => {
    const live = await stream()
    const made = await call('POST', '/api/agents/agent-demo-backend/tasks', { headers: JSON_SAME, body: '{"title":"Through Vite"}' })
    expect(made.status).toBe(202)
    const seen = await live.until((e) => e.type === 'task.started')
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(['task.queued', 'task.started']))
    const lastId = seen.at(-1)!.id
    const before = live.comments.length
    await new Promise((r) => setTimeout(r, 400))
    expect(live.comments.length).toBeGreaterThan(before)
    live.close()
    await call('POST', '/api/agents', { headers: JSON_SAME, body: JSON.stringify({ name: 'Nova', role: 'R', department: 'backend' }) })
    const resumed = await stream({ lastEventId: lastId })
    const first = await resumed.next()
    const seq = (id: string) => Number(id.slice(id.lastIndexOf(':') + 1))
    expect(seq(first.id)).toBeGreaterThan(seq(lastId))
  })

  it('never shows the token and still does not serve the data folder', async () => {
    for (const text of bodies) expect(text).not.toContain(token)
    expect([403, 404]).toContain((await call('GET', '/data/api-token', { headers: SAME })).status)
  })
})
