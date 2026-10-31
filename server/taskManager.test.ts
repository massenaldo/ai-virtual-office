import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../src/workforce/types'
import { silentLogger } from './log'
import { ClaudeAgentRuntimeProvider } from './runtime/claudeAgent'
import { ServerMockProvider } from './runtime/mockProvider'
import type { ServerRuntimeProvider, StartContext } from './runtime/types'
import { openWorkforceStore, type WorkforceStore } from './store'
import { TaskManager, type LifecycleAction, type TaskManagerOptions } from './taskManager'
import { actionDigest } from './toolGate'
import { DEFAULT_ALLOWED_TOOLS } from './toolPolicy'
import { FakeProvider } from './test/fakeProvider'
import { makeWorkspaceRoot } from './test/workspaces'

const NOW = '2026-10-31T09:00:00.000Z'
const FORGE = 'agent-demo-backend'
const INPUT = { title: 'Build API', description: '' }
const BASE_CONFIG = { taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144, workspaceRoot: null as string | null, workspaces: [] as Array<{ id: string; relativePath: string }>, dataDir: undefined as string | undefined }

let dir: string
let store: WorkforceStore
let manager: TaskManager | null = null

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'vo-manager-'))
  store = openWorkforceStore({ dataDir: dir, now: () => NOW, log: silentLogger, writeFile: () => {} })
})
afterEach(async () => {
  await manager?.dispose()
  manager = null
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function make(provider: ServerRuntimeProvider, config: Partial<typeof BASE_CONFIG> = {}, onLifecycle?: TaskManagerOptions['onLifecycle'], allowed: readonly string[] = DEFAULT_ALLOWED_TOOLS): TaskManager {
  manager = new TaskManager({ store, provider, config: { ...BASE_CONFIG, ...config }, policy: { allowedTools: new Set(allowed) }, now: () => NOW, log: silentLogger, onLifecycle })
  return manager
}
const mock = () => new ServerMockProvider({ timings: { thinkingMs: 100, workingMs: 200 } })
const task = (id: string): AgentTask => store.state.tasks.find((t) => t.id === id)!
const agent = (id = FORGE) => store.state.agents.find((a) => a.id === id)!
const tick = () => vi.advanceTimersByTimeAsync(0)

function started(m: TaskManager, workspaceId?: string): string {
  const r = m.startTask(FORGE, INPUT, workspaceId ? { workspaceId } : {})
  if (!r.ok) throw new Error(r.error)
  return r.task.id
}

describe('start and the full mock lifecycle', () => {
  it('runs queued → starting → running → completed with the mock', async () => {
    const m = make(mock())
    const r = m.startTask(FORGE, INPUT)
    expect(r.ok && r.task).toMatchObject({ status: 'starting', runtime: 'mock', timeoutMs: 600000 })
    expect(agent().status).toBe('thinking')
    const id = r.ok ? r.task.id : ''
    await tick()
    expect(task(id).status).toBe('running')
    expect(task(id).executionId).toMatch(/^exec-/)
    await vi.advanceTimersByTimeAsync(300)
    expect(task(id)).toMatchObject({ status: 'completed', endedReason: 'completed' })
    expect(agent().status).toBe('completed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('two startTask calls in the same tick start one run', async () => {
    const fake = new FakeProvider()
    const m = make(fake)
    expect(m.startTask(FORGE, INPUT).ok).toBe(true)
    expect(m.startTask(FORGE, INPUT)).toEqual({ ok: false, code: 'conflict', error: 'Forge already has an active task.' })
    await tick()
    expect(fake.starts).toHaveLength(1)
    expect(store.state.tasks).toHaveLength(1)
  })

  it('refuses when the provider is unavailable', () => {
    const m = make(new ClaudeAgentRuntimeProvider())
    const before = store.state
    expect(m.startTask(FORGE, INPUT)).toEqual({ ok: false, code: 'unavailable', error: 'The claude runtime is not available: Claude Agent SDK not installed.' })
    expect(store.state).toBe(before)
  })

  it('maps not found and invalid input', () => {
    const m = make(new FakeProvider())
    expect(m.startTask('agent-x', INPUT)).toEqual({ ok: false, code: 'not_found', error: 'Agent not found.' })
    expect(m.startTask(FORGE, { title: ' ', description: '' })).toEqual({ ok: false, code: 'invalid', error: 'Title is required.' })
  })

  it('a refused start fails the task', async () => {
    const fake = new FakeProvider()
    fake.defer = true
    const id = started(make(fake))
    await tick()
    fake.resolveStart({ ok: false, error: 'boom' })
    await tick()
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'boom', endedReason: 'failed' })
    expect(agent().status).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a throwing start fails the task', async () => {
    const fake = new FakeProvider()
    fake.defer = true
    const id = started(make(fake))
    await tick()
    fake.rejectStart(new Error('crash'))
    await tick()
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'Runtime failed to start.' })
  })

  it('stops a run whose start finished after it was cancelled', async () => {
    const fake = new FakeProvider()
    fake.defer = true
    const m = make(fake)
    const id = started(m)
    await tick()
    m.cancelTask(id)
    fake.resolveStart({ ok: true, executionId: 'exec-late', sessionId: null })
    await tick()
    expect(fake.cancels.filter((c) => c === id).length).toBeGreaterThanOrEqual(2)
  })
})

describe('timeout and cancel', () => {
  it('times out a run that never ends', async () => {
    const fake = new FakeProvider()
    const id = started(make(fake, { taskTimeoutMs: 1000 }))
    await tick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(task(id)).toMatchObject({ status: 'failed', endedReason: 'timeout', errorMessage: 'Timed out after 1 s' })
    expect(fake.cancels).toEqual([id])
    expect(fake.lastSignal?.aborted).toBe(true)
    const after = store.state
    fake.emit({ type: 'completed', taskId: id, summary: 'late' })
    expect(store.state).toBe(after)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel waits for confirmation, then forces after the grace period', async () => {
    const fake = new FakeProvider()
    const m = make(fake)
    const id = started(m)
    await tick()
    const before = agent().status
    const r = m.cancelTask(id)
    expect(r.ok && r.task.status).toBe('cancelling')
    expect(agent().status).toBe(before)
    await vi.advanceTimersByTimeAsync(4999)
    expect(task(id).status).toBe('cancelling')
    await vi.advanceTimersByTimeAsync(1)
    expect(task(id)).toMatchObject({ status: 'cancelled', endedReason: 'cancelled' })
    expect(agent().status).toBe('idle')
    expect(fake.lastSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel confirmed by the runtime ends at once', () => {
    const m = make(mock())
    const id = started(m)
    const r = m.cancelTask(id)
    expect(r.ok && r.task.status).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel errors and idempotence', async () => {
    const fake = new FakeProvider()
    const m = make(fake)
    expect(m.cancelTask('task-x')).toEqual({ ok: false, code: 'not_found', error: 'Task not found.' })
    const id = started(m)
    await tick()
    expect(m.cancelTask(id).ok).toBe(true)
    const state = store.state
    expect(m.cancelTask(id).ok).toBe(true)
    expect(store.state).toBe(state)
    await vi.advanceTimersByTimeAsync(5000)
    expect(m.cancelTask(id)).toEqual({ ok: false, code: 'conflict', error: 'Task is not active.' })
  })

  it('a late runtime event after a forced cancel changes nothing', async () => {
    const fake = new FakeProvider()
    const m = make(fake)
    const id = started(m)
    await tick()
    m.cancelTask(id)
    await vi.advanceTimersByTimeAsync(5000)
    const state = store.state
    fake.emit({ type: 'cancelled', taskId: id })
    fake.emit({ type: 'completed', taskId: id, summary: 'late' })
    expect(store.state).toBe(state)
  })
})

describe('approvals', () => {
  let aws: ReturnType<typeof makeWorkspaceRoot>
  beforeEach(() => { aws = makeWorkspaceRoot(['sandbox']) })
  afterEach(() => { aws.cleanup() })
  const wc = () => ({ workspaceRoot: aws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }] })
  async function waiting(m: TaskManager): Promise<string> {
    const id = started(m, 'sandbox')
    await tick()
    expect(m.requestApproval(id).ok).toBe(true)
    expect(task(id).status).toBe('waiting_for_approval')
    return id
  }

  it('approval round trip', async () => {
    const m = make(mock(), wc())
    const id = await waiting(m)
    expect(agent().status).toBe('waiting')
    const r = m.decideApproval(id, task(id).pendingApproval!.id, 'approve', {}, task(id).pendingApproval!.digest ?? undefined)
    expect(r.ok && r.task.status).toBe('running')
    expect(agent().status).toBe('working')
    await tick()
    await vi.advanceTimersByTimeAsync(200)
    expect(task(id)).toMatchObject({ status: 'completed', endedReason: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deny fails with the simulated message', async () => {
    const m = make(mock(), wc())
    const id = await waiting(m)
    const r = m.decideApproval(id, task(id).pendingApproval!.id, 'deny', {}, task(id).pendingApproval!.digest ?? undefined)
    // A human deny tells the runtime "no"; the task itself carries on until the runtime decides what to do.
    expect(r.ok && r.task.status).toBe('running')
    await tick()
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'Approval denied (simulated)' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('approval conflicts', async () => {
    const m = make(mock(), wc())
    const id = started(m)
    await tick()
    expect(m.decideApproval(id, 'a', 'approve')).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
    m.requestApproval(id)
    expect(m.decideApproval(id, 'approval-stale', 'approve')).toEqual({ ok: false, code: 'conflict', error: 'That approval is no longer pending.' })
    expect(m.decideApproval('task-x', 'a', 'approve')).toEqual({ ok: false, code: 'not_found', error: 'Task not found.' })
  })

  it('a second decision for the same approval conflicts', async () => {
    const m = make(mock(), wc())
    const id = await waiting(m)
    const approvalId = task(id).pendingApproval!.id
    expect(m.decideApproval(id, approvalId, 'approve', {}, task(id).pendingApproval!.digest ?? undefined).ok).toBe(true)
    expect(m.decideApproval(id, approvalId, 'deny')).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
  })

  it('approval timeout fails the task', async () => {
    const provider = mock()
    const cancel = vi.spyOn(provider, 'cancel')
    const m = make(provider, { ...wc(), approvalTimeoutMs: 2000 })
    const id = await waiting(m)
    await vi.advanceTimersByTimeAsync(2000)
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'No approval decision within 2 s', endedReason: 'failed' })
    expect(cancel).toHaveBeenCalledWith(id)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deciding clears the approval timer', async () => {
    const m = make(mock(), { ...wc(), approvalTimeoutMs: 2000 })
    const id = await waiting(m)
    m.decideApproval(id, task(id).pendingApproval!.id, 'approve', {}, task(id).pendingApproval!.digest ?? undefined)
    await vi.advanceTimersByTimeAsync(1900)
    expect(task(id).status).toBe('completed')
  })

  it('demo controls report their conflicts', async () => {
    const m = make(mock(), wc())
    expect(m.requestApproval('task-x')).toEqual({ ok: false, code: 'not_found', error: 'Task not found.' })
    const id = started(m)
    await tick()
    m.requestApproval(id)
    expect(m.requestApproval(id)).toEqual({ ok: false, code: 'conflict', error: 'Task is not running.' })
    expect(m.forceError(id)).toEqual({ ok: false, code: 'conflict', error: 'Task is not running.' })
  })

  it('demo controls need the mock provider', async () => {
    const fake = new FakeProvider()
    const m = make(fake)
    const id = started(m)
    fake.emit({ type: 'started', taskId: id, executionId: 'e' })
    expect(m.requestApproval(id)).toEqual({ ok: false, code: 'unavailable', error: 'Demo controls need RUNTIME=mock.' })
    expect(m.forceError(id)).toEqual({ ok: false, code: 'unavailable', error: 'Demo controls need RUNTIME=mock.' })
  })

  it('forceError ends a running task failed', async () => {
    const m = make(mock(), wc())
    const id = started(m)
    await tick()
    expect(m.forceError(id).ok).toBe(true)
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'Simulated error (demo control).' })
  })
})

describe('limits and housekeeping', () => {
  it('caps message size and task output', async () => {
    const fake = new FakeProvider()
    const m = make(fake, { maxMessageBytes: 16, maxTaskOutputBytes: 40 })
    const id = started(m)
    await tick()
    fake.emit({ type: 'started', taskId: id, executionId: 'e' })
    fake.emit({ type: 'message', taskId: id, text: 'abcdefghijklmnopqrst' })
    for (let i = 0; i < 3; i++) fake.emit({ type: 'message', taskId: id, text: 'a'.repeat(16) })
    fake.emit({ type: 'message', taskId: id, text: 'more' })
    const messages = store.state.activities.filter((a) => a.taskId === id && a.type === 'agent-message').map((a) => a.message)
    expect(messages).toEqual([
      'abcdefghijklmnop\n[message truncated at 16 B]',
      'a'.repeat(16),
      'a'.repeat(8) + '\n[output limit reached at 40 B; later messages are dropped]',
    ])
  })

  it('cuts progress messages and errors to the message limit but never drops them', async () => {
    const fake = new FakeProvider()
    const m = make(fake, { maxMessageBytes: 16, maxTaskOutputBytes: 40 })
    const id = started(m)
    await tick()
    fake.emit({ type: 'started', taskId: id, executionId: 'e' })
    fake.emit({ type: 'progress', taskId: id, step: 'working', message: 'x'.repeat(30) })
    expect(store.state.activities.at(-1)?.message).toBe('x'.repeat(16) + '\n[message truncated at 16 B]')
    fake.emit({ type: 'failed', taskId: id, error: 'e'.repeat(30) })
    expect(task(id).status).toBe('failed')
    expect(task(id).errorMessage).toBe('e'.repeat(16) + '\n[message truncated at 16 B]')
  })

  it('removeAgent stops its run', async () => {
    const provider = mock()
    const m = make(provider)
    const id = started(m)
    await tick()
    const r = m.removeAgent(FORGE)
    expect(r).toEqual({ ok: true, cancelledTaskId: id })
    expect(provider.status(id)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    expect(agent()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(m.removeAgent(FORGE)).toEqual({ ok: false, code: 'not_found', error: 'Agent not found.' })
  })

  it('removeAgent without a run just removes the agent', () => {
    const m = make(mock())
    expect(m.removeAgent('agent-demo-qa')).toEqual({ ok: true, cancelledTaskId: null })
  })

  it('dispose clears timers and leaves state', async () => {
    const m = make(mock())
    const id = started(m)
    await tick()
    await m.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(task(id).status).toBe('running')
  })

  it('reports lifecycle actions in order', async () => {
    const seen: LifecycleAction[] = []
    const fake = new FakeProvider()
    const m = make(fake, {}, (e) => seen.push(e.action))
    const id = started(m)
    await tick()
    m.cancelTask(id)
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toEqual(['task.start', 'task.cancel', 'task.force_cancelled'])
  })

  it('reports timeout, approval decisions and approval timeout', async () => {
    const seen: string[] = []
    const tws = makeWorkspaceRoot(['sandbox'])
    const m = make(mock(), { taskTimeoutMs: 1000, approvalTimeoutMs: 300, workspaceRoot: tws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }] }, (e) => seen.push(e.action))
    const id = started(m, 'sandbox')
    await tick()
    m.requestApproval(id)
    await vi.advanceTimersByTimeAsync(300)
    expect(seen).toEqual(['task.start', 'tool.asked', 'approval.requested', 'approval.timeout'])
    const m2id = started(m, 'sandbox')
    await tick()
    m.requestApproval(m2id)
    m.decideApproval(m2id, task(m2id).pendingApproval!.id, 'approve', {}, task(m2id).pendingApproval!.digest ?? undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toContain('approval.decided')
    tws.cleanup()
  })
})

describe('workspaces at task start', () => {
  let ws: ReturnType<typeof makeWorkspaceRoot>
  beforeEach(() => { ws = makeWorkspaceRoot(['sandbox']) })
  afterEach(() => { ws.cleanup() })
  const wsConfig = () => ({ workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }] })

  it('passes the resolved workspace to the provider', async () => {
    const fake = new FakeProvider()
    const m = make(fake, wsConfig())
    const r = m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })
    expect(r.ok && r.task.workspaceId).toBe('sandbox')
    await tick()
    expect(fake.starts[0].ctx.workspace).toEqual({ id: 'sandbox', path: ws.path('sandbox') })
  })

  it('refuses an unknown workspace without creating a task', () => {
    const events: unknown[] = []
    const m = make(new FakeProvider(), wsConfig(), (e) => events.push(e))
    const before = store.state.tasks
    expect(m.startTask(FORGE, INPUT, { workspaceId: 'nope' })).toEqual({ ok: false, code: 'invalid', error: 'Unknown workspace "nope".' })
    expect(store.state.tasks).toBe(before)
    expect(events).toEqual([{ action: 'workspace.rejected', actor: 'system', taskId: null, agentId: FORGE, workspaceId: 'nope', reason: 'unknown' }])
  })

  it('maps a malformed id to bad_request', () => {
    const events: Array<Record<string, unknown>> = []
    const m = make(new FakeProvider(), wsConfig(), (e) => events.push(e as Record<string, unknown>))
    expect(m.startTask(FORGE, INPUT, { workspaceId: '../x' })).toEqual({ ok: false, code: 'bad_request', error: '"workspaceId" must be a workspace id: 1–32 lowercase letters, digits or hyphens.' })
    expect('workspaceId' in events[0]).toBe(false)
    expect(events[0]).toMatchObject({ action: 'workspace.rejected', reason: 'invalid_id' })
  })

  it('explains an unconfigured or unavailable workspace', () => {
    const m = make(new FakeProvider())
    expect(m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })).toEqual({ ok: false, code: 'invalid', error: 'Workspaces are not configured on this server.' })
    manager = null
    const m2 = make(new FakeProvider(), wsConfig())
    rmSync(ws.path('sandbox'), { recursive: true })
    expect(m2.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })).toEqual({ ok: false, code: 'invalid', error: 'Workspace "sandbox" is not available.' })
  })

  it('treats a null workspace id as none', async () => {
    const fake = new FakeProvider()
    const m = make(fake, wsConfig())
    const r = m.startTask(FORGE, INPUT, { workspaceId: null })
    expect(r.ok && r.task.workspaceId).toBeNull()
    await tick()
    expect(fake.starts[0].ctx.workspace).toBeNull()
  })

  it('the claude runtime needs a workspace', () => {
    const m = make(new FakeProvider({ kind: 'claude' }), wsConfig())
    expect(m.startTask(FORGE, INPUT)).toEqual({ ok: false, code: 'invalid', error: 'The claude runtime needs a workspace.' })
  })

  it('reports the actor from the request id', () => {
    const events: Array<Record<string, unknown>> = []
    const m = make(new FakeProvider(), {}, (e) => events.push(e as Record<string, unknown>))
    m.startTask(FORGE, INPUT, { requestId: 'r1' })
    expect(events[0]).toMatchObject({ action: 'task.start', actor: 'api', requestId: 'r1' })
  })
})

describe('tool approvals', () => {
  let ws: ReturnType<typeof makeWorkspaceRoot>
  let fake: FakeProvider
  let events: Array<Record<string, unknown>>
  beforeEach(() => { ws = makeWorkspaceRoot(['sandbox']); writeFileSync(join(ws.path('sandbox'), 'notes.md'), 'hello'); fake = new FakeProvider(); events = [] })
  afterEach(() => { ws.cleanup() })

  const wsConfig = (extra: Partial<typeof BASE_CONFIG> = {}) => ({ workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }], ...extra })
  async function running(extra: Partial<typeof BASE_CONFIG> = {}, allowed?: readonly string[]) {
    const m = make(fake, wsConfig(extra), (e) => events.push(e as Record<string, unknown>), allowed)
    const r = m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })
    const id = r.ok ? r.task.id : ''
    await tick()
    fake.emit({ type: 'started', taskId: id, executionId: 'e' })
    return { m, id, ctx: fake.starts[0].ctx }
  }
  const write = { tool: 'Write', input: { file_path: 'notes.md', content: 'hello' } }
  /** The gate's answer without the value perform produced, so the approval outcomes read as before. */
  async function gate(ctx: StartContext, request: { tool: string; input: unknown }) {
    const r = await ctx.tools.use(request, () => 'done')
    if (r.behavior === 'allow') { const { value: _value, ...rest } = r; return rest }
    return r
  }

  it('allows a read inside the workspace without asking', async () => {
    const { id, ctx } = await running()
    await expect(gate(ctx, { tool: 'Read', input: { file_path: 'notes.md' } })).resolves.toEqual({ behavior: 'allow', outcome: 'allowed' })
    expect(task(id).status).toBe('running')
    expect(events.find((e) => e.action === 'tool.allowed')).toMatchObject({ actor: 'runtime', tool: 'Read', decision: 'allow', reason: 'read_only', detail: 'Read notes.md' })
  })

  it('denies unknown, unlisted and outside tools without changing state', async () => {
    const { ctx } = await running()
    const before = store.state
    await expect(gate(ctx, { tool: 'Rm', input: {} })).resolves.toEqual({ behavior: 'deny', outcome: 'denied_by_policy', message: 'Tool "Rm" denied by policy: unknown tool.' })
    expect(store.state).toBe(before)
    await expect(gate(ctx, { tool: 'Bash', input: { command: 'ls' } })).resolves.toMatchObject({ message: 'Tool "Bash" denied by policy: not in ALLOWED_TOOLS.' })
    await expect(gate(ctx, { tool: 'Read', input: { file_path: '/etc/passwd' } })).resolves.toMatchObject({ message: 'Tool "Read" denied by policy: path is outside the task workspace.' })
    expect(store.state).toBe(before)
    const denied = events.filter((e) => e.action === 'tool.denied')
    expect(denied).toHaveLength(3)
    expect(denied.every((e) => e.detail === undefined)).toBe(true)
  })

  describe('the digest travels with the approval', () => {
    const digestOf = (id: string) => actionDigest({ taskId: id, workspaceId: 'sandbox', workspacePath: ws.path('sandbox'), tool: 'Write', input: write.input })

    it('puts the action digest on the pending approval', async () => {
      const { id, ctx } = await running()
      void gate(ctx, write)
      expect(task(id).pendingApproval?.digest).toBe(digestOf(id))
    })

    it('refuses a wrong or missing digest and does not perform', async () => {
      const { m, id, ctx } = await running()
      const perform = vi.fn(() => 'done')
      const pending = ctx.tools.use(write, perform)
      const approval = task(id).pendingApproval!
      const conflict = { ok: false, code: 'conflict', error: 'That approval is no longer pending.' }
      expect(m.decideApproval(id, approval.id, 'approve', {}, 'f'.repeat(64))).toEqual(conflict)
      expect(m.decideApproval(id, approval.id, 'approve')).toEqual(conflict)
      expect(m.decideApproval(id, approval.id, 'approve', {}, digestOf('other-task'))).toEqual(conflict)
      await tick()
      expect(perform).not.toHaveBeenCalled()
      expect(task(id).status).toBe('waiting_for_approval')
      expect(m.decideApproval(id, approval.id, 'approve', {}, approval.digest ?? undefined).ok).toBe(true)
      await expect(pending).resolves.toMatchObject({ behavior: 'allow', outcome: 'approved' })
      expect(perform).toHaveBeenCalledTimes(1)
    })

    it('lets a deny through with the right digest and still needs it', async () => {
      const { m, id, ctx } = await running()
      void gate(ctx, write)
      const approval = task(id).pendingApproval!
      expect(m.decideApproval(id, approval.id, 'deny').ok).toBe(false)
      expect(m.decideApproval(id, approval.id, 'deny', {}, approval.digest ?? undefined).ok).toBe(true)
    })
  })

  it('asks for a write and waits for approval', async () => {
    const { m, id, ctx } = await running()
    let settled: unknown = 'pending'
    void gate(ctx, write).then((r) => { settled = r })
    expect(task(id)).toMatchObject({ status: 'waiting_for_approval', pendingApproval: { tool: 'Write', summary: 'Write notes.md (5 B): "hello"' } })
    expect(agent().status).toBe('waiting')
    await tick()
    expect(settled).toBe('pending')
    expect(m.decideApproval(id, task(id).pendingApproval!.id, 'approve', {}, task(id).pendingApproval!.digest ?? undefined).ok).toBe(true)
    await tick()
    expect(settled).toEqual({ behavior: 'allow', outcome: 'approved' })
    expect(fake.responses).toEqual([])
    expect(task(id).status).toBe('running')
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['tool.asked', 'approval.requested', 'approval.decided']))
  })

  it('a human deny resolves denied and the task keeps running', async () => {
    const { m, id, ctx } = await running()
    const p = gate(ctx, write)
    m.decideApproval(id, task(id).pendingApproval!.id, 'deny', {}, task(id).pendingApproval!.digest ?? undefined)
    await expect(p).resolves.toEqual({ behavior: 'deny', outcome: 'denied', message: 'Denied by a human reviewer.' })
    expect(task(id).status).toBe('running')
  })

  it('approval timeout resolves expired and fails the task', async () => {
    const { m, id, ctx } = await running({ approvalTimeoutMs: 2000 })
    const p = gate(ctx, write)
    const approvalId = task(id).pendingApproval!.id
    await vi.advanceTimersByTimeAsync(2000)
    await expect(p).resolves.toEqual({ behavior: 'deny', outcome: 'expired', message: 'No approval decision within 2 s' })
    expect(task(id).status).toBe('failed')
    expect(vi.getTimerCount()).toBe(0)
    expect(m.decideApproval(id, approvalId, 'approve')).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
  })

  describe.each([
    ['cancelTask', async (m: TaskManager, id: string) => { m.cancelTask(id) }, {}],
    ['the task timeout', async () => { await vi.advanceTimersByTimeAsync(1000) }, { taskTimeoutMs: 1000 }],
    ['removeAgent', async (m: TaskManager) => { m.removeAgent(FORGE) }, {}],
    ['dispose', async (m: TaskManager) => { await m.dispose() }, {}],
  ] as const)('release on %s', (_name, act, extra) => {
    it('releases a waiting request as cancelled exactly once', async () => {
      const { m, id, ctx } = await running(extra)
      const spy = vi.fn()
      void gate(ctx, write).then(spy)
      expect(task(id).status).toBe('waiting_for_approval')
      await act(m, id)
      await tick()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith({ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' })
      await vi.advanceTimersByTimeAsync(10000)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('a second request while one is pending is denied', async () => {
    const { id, ctx } = await running()
    const first = vi.fn()
    void gate(ctx, write).then(first)
    await expect(gate(ctx, write)).resolves.toEqual({ behavior: 'deny', outcome: 'denied_by_policy', message: 'Tool "Write" denied by policy: another tool approval is already pending for this task.' })
    await tick()
    expect(first).not.toHaveBeenCalled()
    expect(task(id).status).toBe('waiting_for_approval')
  })

  it('a request for a task that is not running resolves cancelled', async () => {
    const { id, ctx } = await running()
    const cancelled = { behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }
    fake.emit({ type: 'completed', taskId: id, summary: 'done' })
    await expect(gate(ctx, write)).resolves.toEqual(cancelled)
  })

  it('shows a generic message when the runtime fails to start, and logs the real one', async () => {
    const logged: string[] = []
    const m = make(fake, wsConfig({ dataDir: '/srv/vo/data' }), undefined)
    ;(m as unknown as { log: { error(msg: string, err?: unknown): void } }).log = { ...silentLogger, error: (msg, err) => { logged.push(`${msg} ${String(err)}`) } }
    fake.defer = true
    const r = m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })
    const id = r.ok ? r.task.id : ''
    await tick()
    fake.rejectStart(new Error("ENOENT: open '/srv/vo/data/x'"))
    await tick()
    expect(task(id).errorMessage).toBe('Runtime failed to start.')
    expect(logged.join('\n')).toContain('/srv/vo/data/x')
  })

  it('hides the data folder, the working folder and the home folder in runtime output', async () => {
    const { id } = await running({ dataDir: '/srv/vo/data' })
    fake.emit({ type: 'message', taskId: id, text: `see /srv/vo/data/audit.log, ${process.cwd()}/src and ${homedir()}/.ssh` })
    expect(store.state.activities.at(-1)?.message).toBe('see <data-dir>/audit.log, <cwd>/src and <home>/.ssh')
  })

  it('hides the workspace path in an approval summary', async () => {
    const { id, ctx } = await running({}, ['Bash'])
    void gate(ctx, { tool: 'Bash', input: { command: `cat ${ws.path('sandbox')}/notes.md` } })
    expect(task(id).pendingApproval?.summary).toBe('Run command: cat <workspace>/notes.md')
  })

  it('ignores an approval a real runtime raises by itself, and the decision cannot reach it', async () => {
    const claude = new FakeProvider({ kind: 'claude' })
    const m = make(claude, wsConfig())
    const r = m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })
    const id = r.ok ? r.task.id : ''
    await tick()
    claude.emit({ type: 'started', taskId: id, executionId: 'e' })
    claude.emit({ type: 'approval_requested', taskId: id, approvalId: 'approval-raw', tool: 'Bash', summary: 'rm -rf /' })
    expect(task(id).status).toBe('running')
    expect(task(id).pendingApproval).toBeNull()
    expect(claude.responses).toEqual([])
  })

  it('hides workspace paths in runtime output', async () => {
    const { id } = await running()
    const inside = join(ws.path('sandbox'), 'x.txt')
    fake.emit({ type: 'message', taskId: id, text: `reading ${inside} under ${ws.root}` })
    fake.emit({ type: 'progress', taskId: id, step: 'working', message: `at ${inside}` })
    fake.emit({ type: 'failed', taskId: id, error: `ENOENT: no such file '${inside}'` })
    const text = JSON.stringify(store.state)
    expect(text).not.toContain(ws.root)
    expect(task(id).errorMessage).toBe("ENOENT: no such file '<workspace>/x.txt'")
    expect(store.state.activities.find((a) => a.type === 'agent-message')?.message).toBe('reading <workspace>/x.txt under <workspace-root>')
  })

  it('hides workspace paths in a failed start', async () => {
    fake.defer = true
    const m = make(fake, wsConfig(), (e) => events.push(e as Record<string, unknown>))
    const r = m.startTask(FORGE, INPUT, { workspaceId: 'sandbox' })
    const id = r.ok ? r.task.id : ''
    await tick()
    fake.rejectStart(new Error(`ENOENT '${ws.path('sandbox')}/missing'`))
    await tick()
    expect(task(id).errorMessage).toBe('Runtime failed to start.')
    expect(JSON.stringify(store.state)).not.toContain(ws.root)
  })

  it('scrubs secrets from runtime output', async () => {
    const { id } = await running()
    fake.emit({ type: 'message', taskId: id, text: 'key sk-ant-api03-abcdefghijklmnop' })
    expect(store.state.activities.at(-1)?.message).toBe('key [REDACTED]')
  })

  it('scrubs new secret shapes from messages, progress and failures', async () => {
    const { id } = await running()
    const gh = `ghp_${'a1B2c3D4e5'.repeat(4)}`
    fake.emit({ type: 'message', taskId: id, text: `cloning https://bob:pw@example.com with ${gh}` })
    expect(store.state.activities.at(-1)?.message).toBe('cloning https://[REDACTED]@example.com with [REDACTED]')
    fake.emit({ type: 'failed', taskId: id, error: 'mysql --password hunter2 failed' })
    expect(task(id).errorMessage).toBe('mysql --password [REDACTED] failed')
  })

  it('state never contains the workspace path', async () => {
    const { ctx } = await running()
    void gate(ctx, { tool: 'Write', input: { file_path: join(ws.path('sandbox'), 'notes.md'), content: 'x' } })
    expect(JSON.stringify(store.state)).not.toContain(ws.root)
  })

  it('runtime.note audits for the task', async () => {
    const { ctx } = await running()
    ctx.audit('hello sk-ant-api03-abcdefghijk')
    expect(events.find((e) => e.action === 'runtime.note')).toMatchObject({ actor: 'runtime', taskId: expect.any(String) })
  })
})

