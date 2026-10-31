import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../src/workforce/types'
import { silentLogger } from './log'
import { openWorkforceStore, type WorkforceStore } from './store'
import { TaskManager, type LifecycleEvent } from './taskManager'
import { FakeProvider } from './test/fakeProvider'
import { makeWorkspaceRoot } from './test/workspaces'
import { actionDigest } from './toolGate'
import { DEFAULT_ALLOWED_TOOLS } from './toolPolicy'

// The tool gate through the real TaskManager, store and workspace on disk. Every case ends with the same question: did
// `perform` run? For anything stale, modified or no longer wanted it must not.

const NOW = '2026-10-31T09:00:00.000Z'
const FORGE = 'agent-demo-backend'
const QA = 'agent-demo-qa'
const CONFIG = { taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144 }

let dir: string
let store: WorkforceStore
let ws: ReturnType<typeof makeWorkspaceRoot>
let outside: string
let fake: FakeProvider
let manager: TaskManager
let events: LifecycleEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'vo-gate-int-'))
  outside = mkdtempSync(join(tmpdir(), 'vo-gate-out-'))
  ws = makeWorkspaceRoot(['sandbox', 'other'])
  mkdirSync(join(ws.path('sandbox'), 'sub'))
  store = openWorkforceStore({ dataDir: dir, now: () => NOW, log: silentLogger, writeFile: () => {} })
  fake = new FakeProvider()
  events = []
  manager = new TaskManager({
    store, provider: fake, policy: { allowedTools: new Set(DEFAULT_ALLOWED_TOOLS) },
    config: { ...CONFIG, workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }, { id: 'other', relativePath: 'other' }] },
    now: () => NOW, log: silentLogger, onLifecycle: (e) => events.push(e),
  })
})
afterEach(async () => {
  await manager.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  ws.cleanup()
})

const tick = () => vi.advanceTimersByTimeAsync(0)
const task = (id: string): AgentTask => store.state.tasks.find((t) => t.id === id)!
const actions = () => events.map((e) => e.action)

async function run(agentId = FORGE, index = 0) {
  const r = manager.startTask(agentId, { title: 'T', description: '' }, { workspaceId: 'sandbox' })
  if (!r.ok) throw new Error(r.error)
  await tick()
  fake.emit({ type: 'started', taskId: r.task.id, executionId: `e${index}` })
  return { id: r.task.id, ctx: fake.starts[index].ctx }
}

const write = () => ({ tool: 'Write', input: { file_path: 'sub/out.txt', content: 'x' } })
const approve = (id: string) => {
  const p = task(id).pendingApproval!
  return manager.decideApproval(id, p.id, 'approve', {}, p.digest ?? undefined)
}

describe('stale or unwanted approvals never reach perform: task state', () => {
  it('a cancel right after the approval wins', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    expect(approve(id).ok).toBe(true)
    manager.cancelTask(id)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'cancelled' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('a task that times out while waiting does not perform', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    await vi.advanceTimersByTimeAsync(CONFIG.taskTimeoutMs)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
    expect(task(id).status).toBe('failed')
    expect(perform).not.toHaveBeenCalled()
  })

  it('removing the agent does not perform', async () => {
    const { ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    manager.removeAgent(FORGE)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('the approval timer cannot settle an approval that was already decided', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn(() => 'done')
    const pending = ctx.tools.use(write(), perform)
    expect(approve(id).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(CONFIG.approvalTimeoutMs + 60000)
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', outcome: 'approved' })
    expect(perform).toHaveBeenCalledTimes(1)
    expect(task(id).status).toBe('running')
  })
})

describe('stale or unwanted approvals never reach perform: workspace', () => {
  it('a workspace folder renamed between ask and approve is stale', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    renameSync(ws.path('sandbox'), join(ws.root, 'moved'))
    expect(approve(id).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
    expect(actions()).toContain('tool.stale')
  })

  it('a workspace replaced by a link to another folder is stale', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    rmSync(ws.path('sandbox'), { recursive: true })
    symlinkSync(ws.path('other'), ws.path('sandbox'))
    expect(approve(id).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('a parent folder turned into a link outside the workspace is stale', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    rmSync(join(ws.path('sandbox'), 'sub'), { recursive: true })
    symlinkSync(outside, join(ws.path('sandbox'), 'sub'))
    expect(approve(id).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
    expect(events.find((e) => e.action === 'tool.stale')?.detail).toContain('path or policy check failed')
  })
})

describe('stale or unwanted approvals never reach perform: tool and input', () => {
  it('changing the request after use() changes nothing that reaches perform', async () => {
    const { id, ctx } = await run()
    const request = write()
    const original = structuredClone(request)
    const seen: unknown[] = []
    const pending = ctx.tools.use(request, (action) => { seen.push(action.tool, action.input); return 'done' })
    const digest = task(id).pendingApproval!.digest
    request.tool = 'Edit'
    request.input.file_path = '../../etc/passwd'
    request.input.content = 'tampered'
    expect(task(id).pendingApproval!.digest).toBe(digest)
    expect(digest).toBe(actionDigest({ taskId: id, workspaceId: 'sandbox', workspacePath: ws.path('sandbox'), tool: original.tool, input: original.input }))
    expect(approve(id).ok).toBe(true)
    await pending
    expect(seen).toEqual([original.tool, original.input])
  })

  it('a second request while one is pending is refused and the first still performs only its own input', async () => {
    const { id, ctx } = await run()
    const first = vi.fn(() => 'first')
    const second = vi.fn(() => 'second')
    const pendingFirst = ctx.tools.use(write(), first)
    const refused = await ctx.tools.use({ tool: 'Write', input: { file_path: 'sub/other.txt', content: 'y' } }, second)
    expect(refused).toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    expect(second).not.toHaveBeenCalled()
    expect(approve(id).ok).toBe(true)
    await expect(pendingFirst).resolves.toMatchObject({ behavior: 'allow', value: 'first' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})

describe('an approval is bound to its own task and action', () => {
  it("another task's approval id cannot decide this task", async () => {
    const a = await run(FORGE, 0)
    const b = await run(QA, 1)
    const performA = vi.fn()
    const performB = vi.fn()
    void a.ctx.tools.use(write(), performA)
    void b.ctx.tools.use(write(), performB)
    const approvalB = task(b.id).pendingApproval!
    const conflict = { ok: false, code: 'conflict', error: 'That approval is no longer pending.' }
    expect(manager.decideApproval(a.id, approvalB.id, 'approve', {}, approvalB.digest ?? undefined)).toEqual(conflict)
    expect(task(a.id).status).toBe('waiting_for_approval')
    expect(performA).not.toHaveBeenCalled()
    expect(performB).not.toHaveBeenCalled()
    expect(task(a.id).pendingApproval!.digest).not.toBe(approvalB.digest)
  })

  it('the same approval cannot be used twice', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn(() => 'done')
    const pending = ctx.tools.use(write(), perform)
    const p = task(id).pendingApproval!
    expect(manager.decideApproval(id, p.id, 'approve', {}, p.digest ?? undefined).ok).toBe(true)
    expect(manager.decideApproval(id, p.id, 'approve', {}, p.digest ?? undefined)).toMatchObject({ ok: false, code: 'conflict' })
    await pending
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('an approval decided after its task finished is refused', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    void ctx.tools.use(write(), perform)
    const p = task(id).pendingApproval!
    fake.emit({ type: 'failed', taskId: id, error: 'boom' })
    expect(manager.decideApproval(id, p.id, 'approve', {}, p.digest ?? undefined)).toMatchObject({ ok: false, code: 'conflict' })
    await tick()
    expect(perform).not.toHaveBeenCalled()
  })
})
