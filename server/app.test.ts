import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from './app'
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
})
