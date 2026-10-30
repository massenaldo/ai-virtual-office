import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../src/workforce/types'
import { silentLogger } from './log'
import { ClaudeAgentRuntimeProvider } from './runtime/claudeAgent'
import { ServerMockProvider } from './runtime/mockProvider'
import type { ServerRuntimeProvider } from './runtime/types'
import { openWorkforceStore, type WorkforceStore } from './store'
import { TaskManager, type LifecycleAction, type TaskManagerOptions } from './taskManager'
import { FakeProvider } from './test/fakeProvider'

const NOW = '2026-10-31T09:00:00.000Z'
const FORGE = 'agent-demo-backend'
const INPUT = { title: 'Build API', description: '' }
const BASE_CONFIG = { taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144 }

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

function make(provider: ServerRuntimeProvider, config: Partial<typeof BASE_CONFIG> = {}, onLifecycle?: TaskManagerOptions['onLifecycle']): TaskManager {
  manager = new TaskManager({ store, provider, config: { ...BASE_CONFIG, ...config }, now: () => NOW, log: silentLogger, onLifecycle })
  return manager
}
const mock = () => new ServerMockProvider({ timings: { thinkingMs: 100, workingMs: 200 } })
const task = (id: string): AgentTask => store.state.tasks.find((t) => t.id === id)!
const agent = (id = FORGE) => store.state.agents.find((a) => a.id === id)!
const tick = () => vi.advanceTimersByTimeAsync(0)

function started(m: TaskManager): string {
  const r = m.startTask(FORGE, INPUT)
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
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'Runtime failed to start: crash' })
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
  async function waiting(m: TaskManager): Promise<string> {
    const id = started(m)
    await tick()
    expect(m.requestApproval(id).ok).toBe(true)
    expect(task(id).status).toBe('waiting_for_approval')
    return id
  }

  it('approval round trip', async () => {
    const m = make(mock())
    const id = await waiting(m)
    expect(agent().status).toBe('waiting')
    const r = m.decideApproval(id, task(id).pendingApproval!.id, 'approve')
    expect(r.ok && r.task.status).toBe('running')
    expect(agent().status).toBe('working')
    await vi.advanceTimersByTimeAsync(200)
    expect(task(id)).toMatchObject({ status: 'completed', endedReason: 'completed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deny fails with the simulated message', async () => {
    const m = make(mock())
    const id = await waiting(m)
    const r = m.decideApproval(id, task(id).pendingApproval!.id, 'deny')
    expect(r.ok && r.task).toMatchObject({ status: 'failed', errorMessage: 'Approval denied (simulated)' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('approval conflicts', async () => {
    const m = make(mock())
    const id = started(m)
    await tick()
    expect(m.decideApproval(id, 'a', 'approve')).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
    m.requestApproval(id)
    expect(m.decideApproval(id, 'approval-stale', 'approve')).toEqual({ ok: false, code: 'conflict', error: 'That approval is no longer pending.' })
    expect(m.decideApproval('task-x', 'a', 'approve')).toEqual({ ok: false, code: 'not_found', error: 'Task not found.' })
  })

  it('a second decision for the same approval conflicts', async () => {
    const m = make(mock())
    const id = await waiting(m)
    const approvalId = task(id).pendingApproval!.id
    expect(m.decideApproval(id, approvalId, 'approve').ok).toBe(true)
    expect(m.decideApproval(id, approvalId, 'deny')).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
  })

  it('approval timeout fails the task', async () => {
    const provider = mock()
    const cancel = vi.spyOn(provider, 'cancel')
    const m = make(provider, { approvalTimeoutMs: 2000 })
    const id = await waiting(m)
    await vi.advanceTimersByTimeAsync(2000)
    expect(task(id)).toMatchObject({ status: 'failed', errorMessage: 'No approval decision within 2 s', endedReason: 'failed' })
    expect(cancel).toHaveBeenCalledWith(id)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deciding clears the approval timer', async () => {
    const m = make(mock(), { approvalTimeoutMs: 2000 })
    const id = await waiting(m)
    m.decideApproval(id, task(id).pendingApproval!.id, 'approve')
    await vi.advanceTimersByTimeAsync(1900)
    expect(task(id).status).toBe('completed')
  })

  it('demo controls report their conflicts', async () => {
    const m = make(mock())
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
    const m = make(mock())
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
    const m = make(mock(), { taskTimeoutMs: 1000, approvalTimeoutMs: 300 }, (e) => seen.push(e.action))
    const id = started(m)
    await tick()
    m.requestApproval(id)
    await vi.advanceTimersByTimeAsync(300)
    expect(seen).toEqual(['task.start', 'approval.timeout'])
    const m2id = started(m)
    await tick()
    m.requestApproval(m2id)
    m.decideApproval(m2id, task(m2id).pendingApproval!.id, 'approve')
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toContain('approval.decided')
  })
})
