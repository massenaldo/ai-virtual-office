import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WORKFORCE_FILE } from '../store'
import { api, session, srv, start, stop, tasks, until, type Harness } from '../test/claudeHarness'
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
