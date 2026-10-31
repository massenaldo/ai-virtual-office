import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE, type AuditRecord } from './audit'
import { rawRequest, startTestServer, type TestServer } from './test/helpers'
import { makeWorkspaceRoot } from './test/workspaces'

let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
afterEach(async () => { await s?.close(); s = null; ws?.cleanup(); ws = null })

const FAST = { thinkingMs: 30, workingMs: 30 }
const SLOW = { thinkingMs: 60000, workingMs: 60000 }
const readAudit = (t: TestServer): AuditRecord[] => readFileSync(join(t.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord)
const rawAudit = (t: TestServer) => readFileSync(join(t.dataDir, AUDIT_FILE), 'utf8')
const state = async (t: TestServer) => (await t.api('GET', '/api/state')).body.state
async function until(fn: () => Promise<boolean>, ms = 1500): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('audit wiring', () => {
  it('writes config.startup with ids only', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer({ ...ws.env, ANTHROPIC_API_KEY: 'sk-ant-test-canary-0123456789' })
    const first = readAudit(s)[0]
    expect(first).toMatchObject({ seq: 1, action: 'config.startup', actor: 'system' })
    expect(first.detail).toContain('workspaces=sandbox')
    expect(first.detail).toContain(`port=${s.port}`)
    expect(first.detail).toContain('credentialsConfigured=true')
    expect(first.detail).toContain('allowedTools=Read,Glob,Grep,Write,Edit')
    expect(first.detail).toContain('allowedOrigins=http://localhost:5173,http://127.0.0.1:5173')
    expect(first.detail).not.toContain(ws.root)
    expect(first.detail).not.toContain('sk-ant-test-canary')
  })

  it('audits a full task with a tool approval', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer(ws.env, { mockTimings: FAST })
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    const R = started.headers.get('x-request-id')
    const id = started.body.task.id as string
    await until(async () => (await state(s!)).tasks[0].status === 'running')
    await s.api('POST', `/api/demo/tasks/${id}/request-approval`)
    const pending = (await state(s)).tasks[0].pendingApproval
    const decided = await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'approve' })
    const R2 = decided.headers.get('x-request-id')
    await until(async () => (await state(s!)).tasks[0].status === 'completed')
    const records = readAudit(s).filter((r) => r.taskId === id)
    expect(records.map((r) => r.action)).toEqual(['task.start', 'tool.asked', 'approval.requested', 'approval.decided'])
    expect(records[0]).toMatchObject({ actor: 'api', requestId: R, workspaceId: 'sandbox' })
    expect(records[1]).toMatchObject({ actor: 'runtime', tool: 'Write', detail: 'Write simulated.txt (39 B): "Simulated content (nothing is written)."' })
    expect(records[3]).toMatchObject({ decision: 'approve', requestId: R2 })
  })

  it('audits rejected requests without bodies', async () => {
    s = await startTestServer()
    const json = { 'content-type': 'application/json' }
    await rawRequest(s.url, { method: 'POST', path: '/api/agents', headers: { ...json, origin: 'http://evil.example' }, body: '{"name":"secret-body-canary"}' })
    await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', cwd: '/etc/shadow' })
    await rawRequest(s.url, { path: '/api/state', headers: { host: 'evil.example' } })
    const rejected = readAudit(s).filter((r) => r.action === 'request.rejected')
    expect(rejected).toEqual([
      expect.objectContaining({ actor: 'api', reason: 'origin', detail: 'POST /api/agents' }),
      expect.objectContaining({ reason: 'unknown_field', detail: 'POST /api/agents/agent-demo-backend/tasks' }),
      expect.objectContaining({ reason: 'host', detail: 'GET /api/state' }),
    ])
    expect(rejected.every((r) => /^[0-9a-f]{12}$/.test(r.requestId ?? ''))).toBe(true)
    expect(rawAudit(s)).not.toContain('secret-body-canary')
    expect(rawAudit(s)).not.toContain('/etc/shadow')
  })

  it('audits workspace rejections', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer(ws.env)
    await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: 'nope' })
    await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: '../x' })
    const rejected = readAudit(s).filter((r) => r.action === 'workspace.rejected')
    expect(rejected[0]).toMatchObject({ actor: 'api', agentId: 'agent-demo-backend', workspaceId: 'nope', reason: 'unknown' })
    expect(rejected[1]).toMatchObject({ reason: 'invalid_id' })
    expect('workspaceId' in rejected[1]).toBe(false)
  })

  it('audits cancel and timeouts', async () => {
    s = await startTestServer({}, { mockTimings: SLOW })
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
    await s.api('POST', `/api/tasks/${started.body.task.id}/cancel`)
    expect(readAudit(s).find((r) => r.action === 'task.cancel')).toMatchObject({ actor: 'api' })
    await s.close()
    s = await startTestServer({ TASK_TIMEOUT_MS: '300' }, { mockTimings: SLOW })
    await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Slow' })
    await until(async () => readAudit(s!).some((r) => r.action === 'task.timeout'), 2000)
    expect(readAudit(s).find((r) => r.action === 'task.timeout')).toMatchObject({ actor: 'system' })
  })

  it('audits a policy denial', async () => {
    const ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer({ ALLOWED_TOOLS: 'Read', ...ws.env }, { mockTimings: SLOW })
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    const id = started.body.task.id as string
    await until(async () => (await state(s!)).tasks[0].status === 'running')
    await s.api('POST', `/api/demo/tasks/${id}/request-approval`)
    const denied = readAudit(s).find((r) => r.action === 'tool.denied')!
    expect(denied).toMatchObject({ actor: 'runtime', tool: 'Write', decision: 'deny', reason: 'not_allowed' })
    expect('detail' in denied).toBe(false)
  })
})
