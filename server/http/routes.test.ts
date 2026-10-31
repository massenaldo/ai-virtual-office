import { readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startTestServer, type TestServer } from '../test/helpers'
import { makeWorkspaceRoot } from '../test/workspaces'

let s: TestServer
const SLOW = { thinkingMs: 60000, workingMs: 60000 }
beforeEach(async () => { s = await startTestServer({}, { mockTimings: SLOW }) })
afterEach(async () => { await s.close() })

const state = async () => (await s.api('GET', '/api/state')).body
const task = async (id: string) => (await state()).state.tasks.find((t: { id: string }) => t.id === id)

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 1000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function startForge(): Promise<string> {
  const r = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', description: 'REST' })
  expect(r.status).toBe(202)
  return r.body.task.id
}

describe('state and agents', () => {
  it('GET /api/state returns the snapshot', async () => {
    const r = await s.api('GET', '/api/state')
    expect(r.status).toBe(200)
    expect(r.body.state.agents).toHaveLength(6)
    expect(r.body.lastEventId).toMatch(/^[0-9a-z]+:0$/)
    expect(r.body).toMatchObject({ loadProblem: null, preserved: null, saveError: null })
  })

  it('creates an agent', async () => {
    const r = await s.api('POST', '/api/agents', { name: 'Nova', role: 'Researcher', department: 'backend' })
    expect(r.status).toBe(201)
    expect(r.body.agent).toMatchObject({ name: 'Nova', status: 'idle', runtimeMode: 'mock' })
    const after = await state()
    expect(after.state.agents.some((a: { name: string }) => a.name === 'Nova')).toBe(true)
    expect(Number(after.lastEventId.split(':')[1])).toBeGreaterThanOrEqual(1)
  })

  it('rejects invalid agents', async () => {
    const good = { name: 'Nova', role: 'R', department: 'backend' }
    expect(await s.api('POST', '/api/agents', { ...good, name: '' })).toMatchObject({ status: 422, body: { error: 'Name is required.' } })
    expect(await s.api('POST', '/api/agents', { ...good, cwd: '/' })).toMatchObject({ status: 400, body: { error: 'Unknown field "cwd".' } })
    expect(await s.api('POST', '/api/agents', { ...good, name: 5 })).toMatchObject({ status: 400, body: { error: '"name" must be a string.' } })
    expect(await s.api('POST', '/api/agents', { ...good, department: 'meeting' })).toMatchObject({ status: 422, body: { error: 'Choose a department.' } })
    const plain = await fetch(`${s.url}/api/agents`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(plain.status).toBe(415)
  })

  it('patches an agent', async () => {
    expect(await s.api('PATCH', '/api/agents/agent-demo-qa', { role: 'Lead tester' })).toMatchObject({ status: 200, body: { agent: { role: 'Lead tester' } } })
    expect(await s.api('PATCH', '/api/agents/agent-demo-qa', { role: 'Lead tester' })).toMatchObject({ status: 200 })
    expect(await s.api('PATCH', '/api/agents/agent-x', { role: 'x' })).toMatchObject({ status: 404, body: { error: 'Agent not found.' } })
    expect((await s.api('PATCH', '/api/agents/agent-demo-qa', {})).status).toBe(400)
    expect(await s.api('PATCH', '/api/agents/agent-demo-qa', { name: '  ' })).toMatchObject({ status: 422, body: { error: 'Name is required.' } })
  })

  it('assigns desks', async () => {
    expect(await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: 'desk-03' })).toMatchObject({ status: 409, body: { error: 'That desk is already assigned to Atlas.' } })
    expect(await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: null })).toMatchObject({ status: 200, body: { agent: { deskId: null } } })
    expect(await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: 'desk-14' })).toMatchObject({ status: 200, body: { agent: { deskId: 'desk-14' } } })
    expect((await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: 5 })).status).toBe(400)
    expect((await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: '' })).status).toBe(400)
    expect(await s.api('PUT', '/api/agents/agent-x/desk', { deskId: null })).toMatchObject({ status: 404, body: { error: 'Agent not found.' } })
  })

  it('deletes an agent', async () => {
    expect(await s.api('DELETE', '/api/agents/agent-demo-qa')).toMatchObject({ status: 200, body: { ok: true, cancelledTaskId: null } })
    expect((await s.api('DELETE', '/api/agents/agent-demo-qa')).status).toBe(404)
  })

  it('deleting an agent with a running task cancels it', async () => {
    const id = await startForge()
    expect(await s.api('DELETE', '/api/agents/agent-demo-backend')).toMatchObject({ status: 200, body: { ok: true, cancelledTaskId: id } })
  })
})

describe('tasks', () => {
  it('starts a task', async () => {
    const r = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', description: 'REST' })
    expect(r.status).toBe(202)
    expect(r.body.task).toMatchObject({ status: 'starting', runtime: 'mock', timeoutMs: 600000 })
  })

  it('rejects bad task requests', async () => {
    await startForge()
    expect(await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Again' })).toMatchObject({ status: 409, body: { error: 'Forge already has an active task.' } })
    expect(await s.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: '' })).toMatchObject({ status: 422, body: { error: 'Title is required.' } })
    expect(await s.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 'x', workspaceId: 'sandbox' })).toMatchObject({ status: 422, body: { error: 'Workspaces are not configured on this server.' } })
    expect(await s.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 'x', command: 'rm -rf /' })).toMatchObject({ status: 400, body: { error: 'Unknown field "command".' } })
    expect(await s.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 5 })).toMatchObject({ status: 400, body: { error: '"title" must be a string.' } })
    expect(await s.api('POST', '/api/agents/agent-x/tasks', { title: 'x' })).toMatchObject({ status: 404, body: { error: 'Agent not found.' } })
  })

  it('cancels a task', async () => {
    const id = await startForge()
    const r = await s.api('POST', `/api/tasks/${id}/cancel`)
    expect(r.status).toBe(202)
    expect(r.body.task.status).toBe('cancelled')
    expect(await s.api('POST', `/api/tasks/${id}/cancel`)).toMatchObject({ status: 409, body: { error: 'Task is not active.' } })
    expect(await s.api('POST', '/api/tasks/task-x/cancel')).toMatchObject({ status: 404, body: { error: 'Task not found.' } })
  })

  it('cancel ignores any body', async () => {
    const id = await startForge()
    const r = await s.api('POST', `/api/tasks/${id}/cancel`, { cwd: '/' })
    expect(r.status).toBe(202)
  })

  it('approval via demo controls (without a workspace the simulated run raises its own approval)', async () => {
    const id = await startForge()
    await until(async () => (await task(id))?.status === 'running')
    expect((await s.api('POST', `/api/demo/tasks/${id}/request-approval`)).status).toBe(202)
    const pending = (await task(id)).pendingApproval
    expect((await task(id)).status).toBe('waiting_for_approval')
    expect(pending.tool).toBe('Write')
    expect(await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'maybe' })).toMatchObject({ status: 400, body: { error: '"decision" must be "approve" or "deny".' } })
    expect(await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: '', decision: 'deny' })).toMatchObject({ status: 400, body: { error: '"approvalId" must be a non-empty string.' } })
    expect(pending.summary).toBe('Simulated request to write a file')
    const denied = await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'deny' })
    // Without a workspace the simulated run owns the approval, so a deny ends it at once.
    expect(denied).toMatchObject({ status: 200, body: { task: { status: 'failed' } } })
    await until(async () => (await task(id)).status === 'failed')
    expect(await task(id)).toMatchObject({ errorMessage: 'Approval denied (simulated)' })
    expect(await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'deny' })).toMatchObject({ status: 409, body: { error: 'Task is not waiting for approval.' } })
  })

  it('force-error ends a running task failed', async () => {
    const id = await startForge()
    await until(async () => (await task(id))?.status === 'running')
    expect((await s.api('POST', `/api/demo/tasks/${id}/force-error`)).status).toBe(202)
    expect(await task(id)).toMatchObject({ status: 'failed', errorMessage: 'Simulated error (demo control).' })
    expect(await s.api('POST', `/api/demo/tasks/${id}/force-error`)).toMatchObject({ status: 409, body: { error: 'Task is not running.' } })
  })

  it('restores demo agents', async () => {
    await s.api('DELETE', '/api/agents/agent-demo-qa')
    const r = await s.api('POST', '/api/demo/agents/restore')
    expect(r.status).toBe(200)
    expect(r.body.agents.some((a: { id: string }) => a.id === 'agent-demo-qa')).toBe(true)
  })

  it('an unknown route and a wrong method answer 404 and 405', async () => {
    expect(await s.api('GET', '/api/nope')).toMatchObject({ status: 404, body: { error: 'Not found.' } })
    expect(await s.api('GET', '/api/agents')).toMatchObject({ status: 405, body: { error: 'Method not allowed.' } })
  })
})

describe('the claude runtime', () => {
  it('refuses tasks and hides demo routes', async () => {
    const c = await startTestServer({ RUNTIME: 'claude' })
    try {
      expect((await c.api('GET', '/api/health')).body).toMatchObject({ available: false, reason: 'Claude Agent SDK not installed' })
      expect(await c.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })).toMatchObject({ status: 503, body: { error: 'The claude runtime is not available: Claude Agent SDK not installed.' } })
      expect(await c.api('POST', '/api/demo/agents/restore')).toMatchObject({ status: 404, body: { error: 'Not found.' } })
      const created = await c.api('POST', '/api/agents', { name: 'Nova', role: 'R', department: 'backend' })
      expect(created.body.agent.runtimeMode).toBe('real')
    } finally {
      await c.close()
    }
  })
})

describe('workspaces', () => {
  let ws: ReturnType<typeof makeWorkspaceRoot>
  let w: TestServer
  beforeEach(async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    w = await startTestServer(ws.env, { mockTimings: SLOW })
  })
  afterEach(async () => { await w.close(); ws.cleanup() })
  const taskCount = async () => (await w.api('GET', '/api/state')).body.state.tasks.length as number

  it('lists workspace ids only', async () => {
    const r = await w.api('GET', '/api/workspaces')
    expect(r.body).toEqual({ workspaces: [{ id: 'sandbox' }] })
    expect(JSON.stringify(r.body)).not.toContain(ws.root)
  })

  it('never puts the workspace root in a state, workspace or error response', async () => {
    await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    const bodies = [(await w.api('GET', '/api/state')).body, (await w.api('GET', '/api/workspaces')).body, (await w.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 'x', workspaceId: 'nope' })).body]
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(ws.root)
  })

  it('the demo approval in a workspace goes through the gate and writes nothing', async () => {
    const id = (await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })).body.task.id as string
    await until(async () => (await w.api('GET', '/api/state')).body.state.tasks[0].status === 'running')
    expect((await w.api('POST', `/api/demo/tasks/${id}/request-approval`)).status).toBe(202)
    const pending = (await w.api('GET', '/api/state')).body.state.tasks[0].pendingApproval
    expect(pending).toMatchObject({ tool: 'Write', summary: 'Write simulated.txt (39 B)' })
    await w.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'deny' })
    await until(async () => (await w.api('GET', '/api/state')).body.state.tasks[0].status === 'failed')
    expect((await w.api('GET', '/api/state')).body.state.tasks[0].errorMessage).toBe('Approval denied (simulated)')
    expect(readdirSync(ws.path('sandbox'))).toEqual([])
  })

  it('starts a task in a workspace', async () => {
    const r = await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    expect(r.status).toBe(202)
    expect(r.body.task.workspaceId).toBe('sandbox')
    const none = await w.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 'x', workspaceId: null })
    expect(none.status).toBe(202)
    expect(none.body.task.workspaceId).toBeNull()
  })

  it('rejects bad workspaces with exact copy and creates no task', async () => {
    const before = await taskCount()
    expect(await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: 'nope' })).toMatchObject({ status: 422, body: { error: 'Unknown workspace "nope".' } })
    expect(await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: '../etc' })).toMatchObject({ status: 400, body: { error: '"workspaceId" must be a workspace id: 1–32 lowercase letters, digits or hyphens.' } })
    expect(await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'x', workspaceId: 5 })).toMatchObject({ status: 400, body: { error: '"workspaceId" must be a string or null.' } })
    expect(await taskCount()).toBe(before)
  })

  it('never exposes the workspace path', async () => {
    await w.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
    await w.api('POST', '/api/agents/agent-demo-frontend/tasks', { title: 'x', workspaceId: 'nope' })
    for (const path of ['/api/state', '/api/health', '/api/workspaces']) expect(JSON.stringify((await w.api('GET', path)).body)).not.toContain(ws.root)
  })
})

describe('the demo tool request', () => {
  it('follows ALLOWED_TOOLS', async () => {
    const tws = makeWorkspaceRoot(['sandbox'])
    const t = await startTestServer({ ALLOWED_TOOLS: 'Read', ...tws.env }, { mockTimings: SLOW })
    try {
      const r = await t.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
      const id = r.body.task.id as string
      await until(async () => (await t.api('GET', '/api/state')).body.state.tasks[0].status === 'running')
      expect((await t.api('POST', `/api/demo/tasks/${id}/request-approval`)).status).toBe(202)
      await until(async () => (await t.api('GET', '/api/state')).body.state.tasks[0].status === 'failed')
      expect((await t.api('GET', '/api/state')).body.state.tasks[0].errorMessage).toBe('Tool "Write" denied by policy: not in ALLOWED_TOOLS.')
    } finally {
      await t.close()
      tws.cleanup()
    }
  })

  it('approving the demo write changes nothing on disk', async () => {
    const w = makeWorkspaceRoot(['sandbox'])
    const t = await startTestServer(w.env, { mockTimings: { thinkingMs: 30, workingMs: 30 } })
    try {
      const r = await t.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
      const id = r.body.task.id as string
      const get = async () => (await t.api('GET', '/api/state')).body.state.tasks[0]
      await until(async () => (await get()).status === 'running')
      await t.api('POST', `/api/demo/tasks/${id}/request-approval`)
      const pending = (await get()).pendingApproval
      expect((await t.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'approve' })).status).toBe(200)
      await until(async () => (await get()).status === 'completed')
      expect(readdirSync(w.path('sandbox'))).toEqual([])
    } finally {
      await t.close()
      w.cleanup()
    }
  })
})

