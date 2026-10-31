import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE } from './audit'
import { recordingLogger } from './log'
import { WORKFORCE_FILE } from './store'
import { FakeProvider } from './test/fakeProvider'
import { rawRequest, startTestServer, type TestServer } from './test/helpers'
import { makeWorkspaceRoot } from './test/workspaces'

const CANARY = 'sk-ant-test-canary-0123456789'
let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
afterEach(async () => { await s?.close(); s = null; ws?.cleanup(); ws = null })

async function until(fn: () => Promise<boolean>, ms = 1500): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('secrets and paths', () => {
  it('never writes the API key, request bodies or workspace paths', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    const rec = recordingLogger()
    s = await startTestServer({ ANTHROPIC_API_KEY: CANARY, ...ws.env }, { log: rec, mockTimings: { thinkingMs: 30, workingMs: 30 } })
    const seen: string[] = []
    const keep = (r: { status: number; headers: Headers | Record<string, unknown>; body: unknown }) => {
      const headers = r.headers instanceof Headers ? Object.fromEntries(r.headers.entries()) : r.headers
      seen.push(JSON.stringify({ body: r.body, headers }))
    }
    const health = await s.api('GET', '/api/health')
    keep(health)
    keep(await s.api('GET', '/api/state'))
    keep(await s.api('GET', '/api/workspaces'))
    const plain = await rawRequest(s.url, { method: 'POST', path: '/api/agents', headers: { 'content-type': 'text/plain' }, body: `{"k":"${CANARY}"}` })
    seen.push(JSON.stringify(plain))
    seen.push(JSON.stringify(await rawRequest(s.url, { path: '/api/state', headers: { origin: 'http://evil.example' } })))
    seen.push(JSON.stringify(await rawRequest(s.url, { path: '/api/state', headers: { host: 'evil.example' } })))
    keep(await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: 'nope' }))
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    keep(started)
    const id = started.body.task.id as string
    const get = async () => (await s!.api('GET', '/api/state')).body.state.tasks[0]
    await until(async () => (await get()).status === 'running')
    keep(await s.api('POST', `/api/demo/tasks/${id}/request-approval`))
    keep(await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: (await get()).pendingApproval.id, decision: 'approve' }))
    await until(async () => (await get()).status === 'completed')
    keep(await s.api('GET', '/api/state'))

    const files = [readFileSync(join(s.dataDir, WORKFORCE_FILE), 'utf8'), readFileSync(join(s.dataDir, AUDIT_FILE), 'utf8')]
    const everything = [...seen, ...files, rec.lines.join('\n')]
    for (const text of everything) expect(text).not.toContain(CANARY)
    for (const text of [...seen, ...files]) expect(text).not.toContain(ws.root)
    expect(rec.lines.join('\n')).not.toContain(ws.root)
    expect(health.body.credentialsConfigured).toBe(true)
  })

  it('the redacting logger hides a key that reaches a log line', async () => {
    const rec = recordingLogger()
    const fake = new FakeProvider()
    fake.defer = true
    s = await startTestServer({}, { log: rec, provider: fake })
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
    expect(started.status).toBe(202)
    await new Promise((r) => setTimeout(r, 10))
    fake.rejectStart(new Error('auth failed for sk-ant-api03-abcdefghijk'))
    await until(async () => (await s!.api('GET', '/api/state')).body.state.tasks[0].status === 'failed')
    expect((await s.api('GET', '/api/state')).body.state.tasks[0].errorMessage).toBe('Runtime failed to start: auth failed for [REDACTED]')
    const text = rec.lines.join('\n')
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain('sk-ant-api03-abcdefghijk')
  })
})
