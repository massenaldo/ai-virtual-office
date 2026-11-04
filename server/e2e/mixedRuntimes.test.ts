import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKFORCE_FILE } from '../store'
import { api, pendingApproval, session, srv, start, stop, tasks, until, workspaceRoot, type Harness } from '../test/claudeHarness'
import { startTestServer, tempDataDir } from '../test/helpers'

// Mock and Claude tasks side by side in one real server: RUNTIME=mock is the default, ENABLE_CLAUDE_RUNTIME=yes adds the Claude
// runtime (a fake SDK session here), and each task names the runtime it runs on.

const FORGE = 'agent-demo-backend'
const PM = 'agent-demo-pm'
const SLOW = { thinkingMs: 600000, workingMs: 600000 }
const MIXED = { RUNTIME: 'mock', ENABLE_CLAUDE_RUNTIME: 'yes' }
let h: Harness
afterEach(async () => { await stop() })

const boot = async (env: Record<string, string> = MIXED) => { h = await start(env, undefined, [], { mockTimings: SLOW }) }
const statusOf = async (id: string) => (await tasks()).find((t) => t.id === id)!.status
const startMock = async (agent: string, runtime?: string) => api('POST', `/api/agents/${agent}/tasks`, { title: 'Mock job', ...(runtime ? { runtime } : {}) })

describe('mock and claude tasks in one server', () => {
  it('health lists both runtimes and keeps the default one in the old fields', async () => {
    await boot()
    expect((await api('GET', '/api/health')).body).toMatchObject({ runtime: 'mock', defaultRuntime: 'mock', available: true, reason: null, runtimes: [{ kind: 'mock', available: true, reason: null }, { kind: 'claude', available: true, reason: null }] })
  })

  it('runs a mock task with a demo approval and a claude task at the same time, and cancels each on its own', async () => {
    await boot()
    const mockTask = await startMock(PM, 'mock')
    expect(mockTask.status).toBe(202)
    expect(mockTask.body.task.runtime).toBe('mock')
    const mid = mockTask.body.task.id as string
    await until(async () => (await statusOf(mid)) === 'running')
    expect((await api('POST', `/api/demo/tasks/${mid}/request-approval`)).status).toBe(202)
    await until(async () => (await statusOf(mid)) === 'waiting_for_approval')

    const { id: cid } = await session(h)
    expect((await tasks()).find((t) => t.id === cid)).toMatchObject({ status: 'running' })
    expect(h.query.sessions).toHaveLength(1)

    expect((await api('POST', `/api/tasks/${cid}/cancel`)).status).toBe(202)
    await until(async () => (await statusOf(cid)) === 'cancelled')
    expect(await statusOf(mid)).toBe('waiting_for_approval')

    expect((await api('POST', `/api/tasks/${mid}/cancel`)).status).toBe(202)
    await until(async () => (await statusOf(mid)) === 'cancelled')
  })

  it('gives a task that names no runtime the default one, which is the mock', async () => {
    await boot()
    const r = await startMock(PM)
    expect(r.status).toBe(202)
    expect(r.body.task.runtime).toBe('mock')
    expect(h.query.sessions).toHaveLength(0)
  })

  it('refuses a claude task that names no workspace, and a runtime that is not one of the two', async () => {
    await boot()
    expect(await startMock(FORGE, 'claude')).toMatchObject({ status: 422, body: { error: 'The claude runtime needs a workspace.' } })
    expect(await startMock(FORGE, 'gpt')).toMatchObject({ status: 400, body: { error: '"runtime" must be "mock" or "claude".' } })
    expect((await tasks())).toHaveLength(0)
  })

  it('refuses to run a task on claude when the server did not enable it', async () => {
    await boot({ RUNTIME: 'mock' })
    const r = await api('POST', `/api/agents/${FORGE}/tasks`, { title: 'Nope', runtime: 'claude', workspaceId: 'sandbox' })
    expect(r).toMatchObject({ status: 422, body: { error: 'The "claude" runtime is not enabled on this server.' } })
    expect((await api('GET', '/api/health')).body.runtimes).toEqual([{ kind: 'mock', available: true, reason: null }])
    expect(await tasks()).toHaveLength(0)
    expect(h.query.sessions).toHaveLength(0)
  })

  it('answers demo routes on the mock task and refuses them on the claude task', async () => {
    await boot()
    const mid = (await startMock(PM, 'mock')).body.task.id as string
    await until(async () => (await statusOf(mid)) === 'running')
    expect((await api('POST', `/api/demo/tasks/${mid}/force-error`)).status).toBe(202)
    await until(async () => (await statusOf(mid)) === 'failed')

    const { id: cid } = await session(h)
    expect(await api('POST', `/api/demo/tasks/${cid}/request-approval`)).toMatchObject({ status: 503, body: { error: 'Demo controls only work for mock tasks.' } })
    expect(await api('POST', `/api/demo/tasks/${cid}/force-error`)).toMatchObject({ status: 503, body: { error: 'Demo controls only work for mock tasks.' } })
    expect(await statusOf(cid)).toBe('running')
  })

  it('counts only claude tasks against the limit', async () => {
    await boot({ ...MIXED, MAX_CONCURRENT_TASKS: '1' })
    await session(h)
    expect((await startMock(PM, 'mock')).status).toBe(202)
    expect((await startMock('agent-demo-frontend')).status).toBe(202)
    const second = await api('POST', '/api/agents/agent-demo-qa/tasks', { title: 'Second', runtime: 'claude', workspaceId: 'sandbox' })
    expect(second).toMatchObject({ status: 409, body: { error: 'A Claude task is already running, which is the limit. Wait for one to finish.' } })
  })

  it('fails both kinds of interrupted tasks after a restart', async () => {
    await boot()
    const mid = (await startMock(PM, 'mock')).body.task.id as string
    await until(async () => (await statusOf(mid)) === 'running')
    const { id: cid } = await session(h)
    const copy = tempDataDir()
    mkdirSync(copy, { recursive: true })
    copyFileSync(join(srv().dataDir, WORKFORCE_FILE), join(copy, WORKFORCE_FILE))
    const again = await startTestServer({ DATA_DIR: copy, RUNTIME: 'mock', ENABLE_CLAUDE_RUNTIME: 'yes' })
    try {
      const state = (await again.api('GET', '/api/state')).body.state.tasks as Array<{ id: string; status: string; errorMessage: string | null }>
      expect(state.find((t) => t.id === mid)).toMatchObject({ status: 'failed', errorMessage: 'Interrupted by a server restart' })
      expect(state.find((t) => t.id === cid)).toMatchObject({ status: 'failed', errorMessage: 'Interrupted by a server restart' })
    } finally {
      await again.close()
    }
  })
})

// A simulated approval must never become a permission that real Claude writes could use.
describe('mock approvals and Claude writes do not share permissions', () => {
  const BROAD = { ...MIXED, ALLOW_BROAD_WRITE_SCOPES: 'yes' }
  const decide = (id: string, p: { id: string; digest: string | null }, decision: string) => api('POST', `/api/tasks/${id}/approval`, { approvalId: p.id, decision, digest: p.digest })
  const cancel = async (id: string) => { expect((await api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202); await until(async () => (await statusOf(id)) === 'cancelled') }
  const rules = async () => (await api('GET', '/api/permissions')).body.rules as Array<{ scope: string; tool: string; runtime: string | null }>

  async function mockDemoApproval() {
    const r = await api('POST', `/api/agents/${FORGE}/tasks`, { title: 'Mock job', runtime: 'mock', workspaceId: 'sandbox' })
    expect(r.status).toBe(202)
    const id = r.body.task.id as string
    await until(async () => (await statusOf(id)) === 'running')
    expect((await api('POST', `/api/demo/tasks/${id}/request-approval`)).status).toBe(202)
    return { id, pending: await pendingApproval(id) }
  }

  it('offers a mock approval once only, and refuses allow_agent and allow_task, when Claude is registered', async () => {
    await boot(BROAD)
    const { id, pending } = await mockDemoApproval()
    expect(pending).toMatchObject({ tool: 'Write', onceOnly: true })
    for (const choice of ['allow_agent', 'allow_task']) {
      expect(await decide(id, pending, choice)).toMatchObject({ status: 422 })
    }
    expect((await rules()).filter((r) => r.scope === 'agent' || r.scope === 'task')).toEqual([])
    expect((await decide(id, pending, 'allow_once')).status).toBe(200)
  })

  it('a mock approval does not let a later Claude vo_write through without asking', async () => {
    await boot(BROAD)
    const { id, pending } = await mockDemoApproval()
    await decide(id, pending, 'allow_agent')
    await decide(id, pending, 'allow_once')
    await cancel(id)
    const c = await session(h)
    const call = c.call('vo_write', { file_path: 'src/real.ts', content: 'real\n' })
    const p = await pendingApproval(c.id)
    expect(p).toMatchObject({ tool: 'Write' })
    expect(existsSync(join(workspaceRoot(), 'sandbox', 'src', 'real.ts'))).toBe(false)
    await decide(c.id, p, 'reject')
    expect((await call).isError).toBe(true)
  })

  it('a rule granted with the mock runtime never answers a Claude write, whatever its scope', async () => {
    await boot(BROAD)
    const app = srv().app
    for (const scope of ['agent'] as const) expect(app.permissions.grant({ scope, effect: 'allow', tool: 'Write', agentId: FORGE, runtime: 'mock', createdBy: 'user' }).ok).toBe(true)
    const c = await session(h)
    const call = c.call('vo_write', { file_path: 'src/real.ts', content: 'real\n' })
    const p = await pendingApproval(c.id)
    expect(existsSync(join(workspaceRoot(), 'sandbox', 'src', 'real.ts'))).toBe(false)
    await decide(c.id, p, 'reject')
    await call
  })

  it('a Claude allow_agent still covers later Claude tasks, is recorded as a Claude rule, and does not cover a mock approval', async () => {
    await boot(BROAD)
    const a = await session(h)
    const first = a.call('vo_write', { file_path: 'one.txt', content: '1\n' })
    await decide(a.id, await pendingApproval(a.id), 'allow_agent')
    expect((await first).isError).toBeUndefined()
    expect(await rules()).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'agent', tool: 'Write', runtime: 'claude' })]))
    await cancel(a.id)
    const b = await session(h, FORGE, 1)
    expect((await b.call('vo_write', { file_path: 'two.txt', content: '2\n' })).isError).toBeUndefined()
    expect(readFileSync(join(workspaceRoot(), 'sandbox', 'two.txt'), 'utf8')).toBe('2\n')
    await cancel(b.id)
    const m = await mockDemoApproval()
    expect(m.pending.tool).toBe('Write')
  })

  it('a mock-only server keeps offering the broad choices on a simulated approval', async () => {
    await boot({ RUNTIME: 'mock' })
    const r = await api('POST', `/api/agents/${FORGE}/tasks`, { title: 'Mock job', workspaceId: 'sandbox' })
    const id = r.body.task.id as string
    await until(async () => (await statusOf(id)) === 'running')
    await api('POST', `/api/demo/tasks/${id}/request-approval`)
    const pending = await pendingApproval(id)
    expect(pending.onceOnly).not.toBe(true)
    expect((await decide(id, pending, 'allow_agent')).status).toBe(200)
  })
})
