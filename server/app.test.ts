import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from './app'
import { silentLogger } from './log'
import { WORKFORCE_FILE } from './store'
import { rawRequest, startTestServer, tempDataDir, testConfig, TEST_TOKEN, type TestServer } from './test/helpers'

let running: { close(): Promise<void> } | null = null
afterEach(async () => { await running?.close(); running = null })

describe('app', () => {
  it('GET /api/health reports the mock runtime', async () => {
    const s: TestServer = await startTestServer()
    running = s
    const res = await s.api('GET', '/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, runtime: 'mock', available: true, reason: null, credentialsConfigured: false, version: '0.1.0', audit: { ok: true, error: null } })
  })

  it('reports the claude runtime as unavailable without the SDK', async () => {
    const s = await startTestServer({ RUNTIME: 'claude', ANTHROPIC_API_KEY: 'sk-test-123' })
    running = s
    const res = await s.api('GET', '/api/health')
    expect(res.body).toMatchObject({ runtime: 'claude', available: false, reason: 'Claude Agent SDK not installed', credentialsConfigured: true })
    expect(JSON.stringify(res.body)).not.toContain('sk-test-123')
  })

  it('health and state show a save failure as a code and a fixed sentence, never a path', async () => {
    const dataDir = tempDataDir()
    let fail = false
    const s = await startTestServer({ DATA_DIR: dataDir }, { storeWriteFile: (path, text) => { if (fail) throw Object.assign(new Error(`EACCES: permission denied, open '${dataDir}/workforce.json.tmp-9'`), { code: 'EACCES' }); writeFileSync(path, text) } })
    running = s
    fail = true
    expect((await s.api('POST', '/api/agents', { name: 'Nova', role: 'R', department: 'backend' })).status).toBe(201)
    const open = await rawRequest(s.url, { path: '/api/health', noAuth: true })
    expect(JSON.parse(open.body).persistence).toEqual({ ok: false, error: 'EACCES' })
    expect(open.body).not.toContain(dataDir)
    expect(open.body).not.toMatch(/\/(tmp|var|private|Users|home)\//)
    const state = await s.api('GET', '/api/state')
    expect(state.body.saveError).toBe('Permission denied (EACCES).')
    expect(JSON.stringify(state.body.saveError)).not.toContain(dataDir)
    fail = false
    await s.api('POST', '/api/agents', { name: 'Quill', role: 'R', department: 'backend' })
    expect(JSON.parse((await rawRequest(s.url, { path: '/api/health', noAuth: true })).body).persistence).toEqual({ ok: true, error: null })
  })

  it('health reports an unavailable audit log and the server keeps serving', async () => {
    const dataDir = tempDataDir()
    mkdirSync(join(dataDir, 'audit.log'))
    const s = await startTestServer({ DATA_DIR: dataDir })
    running = s
    expect((await s.api('GET', '/api/health')).body.audit).toEqual({ ok: false, error: 'EISDIR' })
    expect((await s.api('GET', '/api/state')).status).toBe(200)
  })

  it('refuses a second server on the same DATA_DIR and leaves the first one working', async () => {
    const dataDir = tempDataDir()
    const first = await startTestServer({ DATA_DIR: dataDir, API_TOKEN: '' })
    running = first
    const token = readFileSync(join(dataDir, 'api-token'), 'utf8')
    await expect(startServer(testConfig({ DATA_DIR: dataDir }), { log: silentLogger })).rejects.toThrow('Another server is using DATA_DIR.')
    expect(readFileSync(join(dataDir, 'api-token'), 'utf8')).toBe(token)
    expect((await first.api('GET', '/api/state')).status).toBe(200)
  })

  it('binds 127.0.0.1 by default', async () => {
    const s = await startServer(testConfig())
    running = s
    expect(s.url.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('health includes persistence and startedAt', async () => {
    const s = await startTestServer()
    running = s
    const body = (await s.api('GET', '/api/health')).body
    expect(body.persistence).toEqual({ ok: true, error: null })
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt)
  })
})

describe('restarts', () => {
  const call = async (url: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${TEST_TOKEN}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as any }
  }

  it('state survives a restart', async () => {
    const config = testConfig()
    try {
      const first = await startServer(config, { log: silentLogger })
      const agents = (await call(first.url, 'GET', '/api/state')).body.state.agents as Array<{ id: string }>
      for (const a of agents) await call(first.url, 'DELETE', `/api/agents/${a.id}`)
      await call(first.url, 'POST', '/api/agents', { name: 'Nova', role: 'R', department: 'backend' })
      await first.close()

      const second = await startServer(config, { log: silentLogger })
      const after = (await call(second.url, 'GET', '/api/state')).body.state.agents as Array<{ name: string }>
      expect(after.map((a) => a.name)).toEqual(['Nova'])
      await second.close()
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true })
    }
  })

  it('a task running at shutdown is failed on restart', async () => {
    const config = testConfig()
    try {
      const first = await startServer(config, { log: silentLogger, mockTimings: { thinkingMs: 60000, workingMs: 60000 } })
      const started = await call(first.url, 'POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
      expect(started.status).toBe(202)
      await new Promise((r) => setTimeout(r, 20))
      await first.close()

      const second = await startServer(config, { log: silentLogger })
      const state = (await call(second.url, 'GET', '/api/state')).body.state
      expect(state.tasks[0]).toMatchObject({ status: 'failed', errorMessage: 'Interrupted by a server restart', endedReason: 'failed' })
      await second.close()
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true })
    }
  })

  it('a second launch on a busy port fails before it touches the data file', async () => {
    const config = testConfig()
    try {
      const first = await startServer(config, { log: silentLogger, mockTimings: { thinkingMs: 60000, workingMs: 60000 } })
      const started = await call(first.url, 'POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
      expect(started.status).toBe(202)
      await new Promise((r) => setTimeout(r, 20))
      const file = join(config.dataDir, WORKFORCE_FILE)
      const before = readFileSync(file, 'utf8')

      await expect(startServer({ ...config, port: first.port }, { log: silentLogger })).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(readFileSync(file, 'utf8')).toBe(before)
      expect(JSON.parse(before).tasks[0].status).not.toBe('failed')
      await first.close()
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true })
    }
  })
})
