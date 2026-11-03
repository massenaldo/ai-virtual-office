import { afterEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from './test/helpers'
import { makeWorkspaceRoot } from './test/workspaces'

// What the task form's workspace choice means on the server. The browser only names a workspace; the server decides whether it
// exists, binds the approval to it and refuses a scope the approval can't support.

let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
afterEach(async () => { await s?.close(); s = null; ws?.cleanup(); ws = null })

const TIMINGS = { thinkingMs: 20, workingMs: 20000 }
type Task = { id: string; status: string; workspaceId: string | null; pendingApproval: { id: string; digest: string | null; review: { workspaceId: string; digest: string } | null } | null }
const tasks = async () => (await s!.api('GET', '/api/state')).body.state.tasks as Task[]
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('condition not met in time')
}
async function begin(agent: string, workspaceId?: string): Promise<string> {
  const r = await s!.api('POST', `/api/agents/${agent}/tasks`, { title: 'T', ...(workspaceId ? { workspaceId } : {}) })
  expect(r.status).toBe(202)
  const id = r.body.task.id as string
  await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'running')
  return id
}
async function ask(id: string): Promise<NonNullable<Task['pendingApproval']>> {
  await s!.api('POST', `/api/demo/tasks/${id}/request-approval`)
  await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
  return (await tasks()).find((t) => t.id === id)!.pendingApproval!
}

describe('workspace choice on the server', () => {
  it('lists registered ids only, never a path', async () => {
    ws = makeWorkspaceRoot(['sandbox', 'docs'])
    s = await startTestServer({ ...ws.env }, { mockTimings: TIMINGS })
    const r = await s.api('GET', '/api/workspaces')
    expect((r.body as { workspaces: { id: string }[] }).workspaces.map((w) => w.id).sort()).toEqual(['docs', 'sandbox'])
    expect(Object.keys((r.body as { workspaces: object[] }).workspaces[0])).toEqual(['id'])
    expect(JSON.stringify(r.body)).not.toContain(ws.root)
  })

  it('refuses an id the server did not register, even a well-formed one, and starts no task', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer({ ...ws.env }, { mockTimings: TIMINGS })
    expect((await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'T', workspaceId: 'ghost' })).status).toBe(422)
    expect((await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'T', workspaceId: '../sandbox' })).status).toBe(400)
    expect(await tasks()).toHaveLength(0)
  })

  it('keeps the workspace on the task and ties each approval to it: another task\'s digest is refused', async () => {
    ws = makeWorkspaceRoot(['sandbox', 'docs'])
    s = await startTestServer({ ...ws.env }, { mockTimings: TIMINGS })
    const a = await begin('agent-demo-backend', 'sandbox')
    const b = await begin('agent-demo-pm', 'docs')
    expect((await tasks()).find((t) => t.id === a)!.workspaceId).toBe('sandbox')
    const pa = await ask(a)
    const pb = await ask(b)
    expect(pa.review!.workspaceId).toBe('sandbox')
    expect(pb.review!.workspaceId).toBe('docs')
    expect(pa.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(pa.digest).not.toBe(pb.digest)
    const wrong = await s.api('POST', `/api/tasks/${a}/approval`, { approvalId: pa.id, decision: 'allow_task', digest: pb.digest })
    expect(wrong.status).toBe(409)
    expect(s.app.permissions.rules.some((r) => r.scope === 'task')).toBe(false)
    expect((await s.api('POST', `/api/tasks/${a}/approval`, { approvalId: pa.id, decision: 'allow_task', digest: pa.digest })).status).toBe(200)
    expect(s.app.permissions.rules.find((r) => r.scope === 'task')).toMatchObject({ taskId: a, tool: 'Write' })
  })

  it('without a workspace the approval has no digest and a task or agent allow is refused', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer({ ...ws.env }, { mockTimings: TIMINGS })
    const id = await begin('agent-demo-backend')
    const p = await ask(id)
    expect(p.digest).toBeNull()
    for (const decision of ['allow_task', 'allow_agent']) {
      const r = await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: p.id, decision })
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
    expect(s.app.permissions.rules.some((r) => r.scope === 'task' || r.scope === 'agent')).toBe(false)
    expect((await tasks()).find((t) => t.id === id)!.status).toBe('waiting_for_approval')
  })
})
