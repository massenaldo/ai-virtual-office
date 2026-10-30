import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from './app'
import { silentLogger } from './log'
import { startTestServer, testConfig, type TestServer } from './test/helpers'

let running: { close(): Promise<void> } | null = null
afterEach(async () => { await running?.close(); running = null })

describe('app', () => {
  it('GET /api/health reports the mock runtime', async () => {
    const s: TestServer = await startTestServer()
    running = s
    const res = await s.api('GET', '/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, runtime: 'mock', available: true, reason: null, credentialsConfigured: false, version: '0.1.0' })
  })

  it('reports the claude runtime as unavailable without the SDK', async () => {
    const s = await startTestServer({ RUNTIME: 'claude', ANTHROPIC_API_KEY: 'sk-test-123' })
    running = s
    const res = await s.api('GET', '/api/health')
    expect(res.body).toMatchObject({ runtime: 'claude', available: false, reason: 'Claude Agent SDK not installed', credentialsConfigured: true })
    expect(JSON.stringify(res.body)).not.toContain('sk-test-123')
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
    const res = await fetch(`${url}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
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
})
