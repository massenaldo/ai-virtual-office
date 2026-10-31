import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import type { AgentTask } from '../../src/workforce/types'
import { testStartContext } from '../test/startContext'
import { MOCK_DEMO_WRITE, ServerMockProvider } from './mockProvider'
import type { StartContext, ToolGateResult } from './types'

const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const forge = demo.agents.find((a) => a.id === 'agent-demo-backend')!

function newTask(): AgentTask {
  const r = assignTask(demo, forge.id, { title: 'Build API', description: '' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return r.state.tasks[0]
}

let provider: ServerMockProvider
let events: RuntimeEvent[]
const start = (task: AgentTask) => provider.start(task, testStartContext(forge))

beforeEach(() => {
  vi.useFakeTimers()
  provider = new ServerMockProvider({ timings: { thinkingMs: 100, workingMs: 200 } })
  events = []
  provider.subscribe((e) => events.push(e))
})
afterEach(async () => { await provider.dispose(); vi.useRealTimers() })

describe('ServerMockProvider', () => {
  it('is an available mock provider', () => {
    expect(provider.kind).toBe('mock')
    expect(provider.availability).toEqual({ available: true })
  })

  it('start resolves an executionId and sessionId null', async () => {
    const outcome = await start(newTask())
    expect(outcome).toMatchObject({ ok: true, sessionId: null })
    expect(outcome.ok && outcome.executionId).toMatch(/^exec-/)
  })

  it('status runs then ends completed and result has the summary', async () => {
    const task = newTask()
    const outcome = await start(task)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.status(task.id)).toMatchObject({ state: 'running', executionId: outcome.ok ? outcome.executionId : '', sessionId: null, pendingApprovalId: null })
    expect(provider.result(task.id)).toBeNull()
    await vi.advanceTimersByTimeAsync(300)
    expect(provider.status(task.id)).toMatchObject({ state: 'ended', outcome: 'completed' })
    expect(provider.result(task.id)).toEqual({ outcome: 'completed', summary: 'Simulated result for "Build API". No AI was run.' })
    expect(events.map((e) => e.type)).toEqual(['started', 'progress', 'progress', 'completed'])
  })

  it('cancel ends cancelled', async () => {
    const task = newTask()
    await start(task)
    provider.cancel(task.id)
    expect(provider.status(task.id)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    expect(provider.result(task.id)).toEqual({ outcome: 'cancelled' })
  })

  it('status is unknown for an unknown task and result is null', () => {
    expect(provider.status('task-x')).toEqual({ state: 'unknown' })
    expect(provider.result('task-x')).toBeNull()
  })

  describe('the demo tool request', () => {
    const settle = (value: ToolGateResult) => { resolveGate(value) }
    let resolveGate: (r: ToolGateResult) => void
    let asked: ReturnType<typeof vi.fn>
    const startWithGate = async () => {
      const task = newTask()
      asked = vi.fn(() => new Promise<ToolGateResult>((resolve) => { resolveGate = resolve }))
      await provider.start(task, testStartContext(forge, { workspace: { id: 'sandbox', path: '/tmp/sandbox' }, requestToolApproval: asked as unknown as StartContext['requestToolApproval'] }))
      await vi.advanceTimersByTimeAsync(0)
      return task
    }

    it('without a workspace the simulated run keeps its own approval and the gate is not asked', async () => {
      const task = newTask()
      const gate = vi.fn()
      await provider.start(task, testStartContext(forge, { requestToolApproval: gate as unknown as StartContext['requestToolApproval'] }))
      await vi.advanceTimersByTimeAsync(0)
      const before = events.length
      provider.requestApproval(task.id)
      expect(gate).not.toHaveBeenCalled()
      const raised = events.slice(before).find((e) => e.type === 'approval_requested')
      expect(raised).toMatchObject({ type: 'approval_requested', taskId: task.id, tool: 'Write' })
      const id = raised?.type === 'approval_requested' ? raised.approvalId : ''
      const status = provider.status(task.id)
      expect(status.state === 'running' && status.pendingApprovalId).toBe(id)
      provider.respondToApproval(task.id, id, 'approve')
      await vi.advanceTimersByTimeAsync(300)
      expect(provider.result(task.id)).toMatchObject({ outcome: 'completed' })
    })

    it('requestApproval asks through the context and deny ends failed', async () => {
      const task = await startWithGate()
      const before = events.length
      provider.requestApproval(task.id)
      expect(asked).toHaveBeenCalledWith({ tool: 'Write', input: MOCK_DEMO_WRITE })
      const status = provider.status(task.id)
      expect(status.state === 'running' && status.pendingApprovalId).toMatch(/^approval-/)
      expect(events.slice(before).some((e) => e.type === 'approval_requested')).toBe(false)
      settle({ behavior: 'deny', outcome: 'denied', message: 'x' })
      await vi.advanceTimersByTimeAsync(0)
      expect(provider.result(task.id)).toEqual({ outcome: 'failed', error: 'Approval denied (simulated)' })
    })

    it('approve continues to completion', async () => {
      const task = await startWithGate()
      provider.requestApproval(task.id)
      settle({ behavior: 'allow', outcome: 'approved' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(provider.result(task.id)).toMatchObject({ outcome: 'completed' })
    })

    it('a policy denial fails with its message', async () => {
      const task = await startWithGate()
      provider.requestApproval(task.id)
      settle({ behavior: 'deny', outcome: 'denied_by_policy', message: 'M' })
      await vi.advanceTimersByTimeAsync(0)
      expect(provider.result(task.id)).toEqual({ outcome: 'failed', error: 'M' })
    })

    it.each(['expired', 'cancelled'] as const)('%s leaves the run to the manager', async (outcome) => {
      const task = await startWithGate()
      provider.requestApproval(task.id)
      const count = events.length
      settle({ behavior: 'deny', outcome, message: 'm' })
      await vi.advanceTimersByTimeAsync(0)
      expect(events).toHaveLength(count)
      expect(provider.result(task.id)).toBeNull()
    })

    it('ignores a second request and a request before the run started', async () => {
      const task = newTask()
      asked = vi.fn(() => new Promise<ToolGateResult>(() => {}))
      await provider.start(task, testStartContext(forge, { workspace: { id: 'sandbox', path: '/tmp/sandbox' }, requestToolApproval: asked as unknown as StartContext['requestToolApproval'] }))
      provider.requestApproval(task.id)
      expect(asked).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(0)
      provider.requestApproval(task.id)
      provider.requestApproval(task.id)
      expect(asked).toHaveBeenCalledTimes(1)
    })
  })

  it('forceError ends failed with the demo message', async () => {
    const task = newTask()
    await start(task)
    await vi.advanceTimersByTimeAsync(0)
    provider.forceError(task.id)
    expect(provider.result(task.id)).toEqual({ outcome: 'failed', error: 'Simulated error (demo control).' })
  })

  it('a refused inner start resolves ok false and keeps no record', async () => {
    const task = newTask()
    await start(task)
    expect(await start(task)).toEqual({ ok: false, error: 'Task is already running.' })
  })

  it('dispose emits nothing more and clears timers', async () => {
    const task = newTask()
    await start(task)
    await provider.dispose()
    const count = events.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(events).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps only the newest 200 ended records', async () => {
    const ids: string[] = []
    for (let i = 0; i < 205; i++) {
      const task = { ...newTask(), id: `task-${i}` }
      await start(task)
      provider.cancel(task.id)
      ids.push(task.id)
    }
    expect(provider.status(ids[0])).toEqual({ state: 'unknown' })
    expect(provider.status(ids[4])).toEqual({ state: 'unknown' })
    expect(provider.status(ids[5])).toMatchObject({ state: 'ended' })
    expect(provider.status(ids[204])).toMatchObject({ state: 'ended' })
  })
})
