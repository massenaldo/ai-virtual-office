import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import type { AgentTask } from '../../src/workforce/types'
import { testStartContext } from '../test/startContext'
import { ServerMockProvider } from './mockProvider'

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

  it('requestApproval sets pendingApprovalId and deny ends failed', async () => {
    const task = newTask()
    await start(task)
    await vi.advanceTimersByTimeAsync(0)
    provider.requestApproval(task.id)
    const status = provider.status(task.id)
    expect(status.state === 'running' && status.pendingApprovalId).toMatch(/^approval-/)
    const ask = events.find((e) => e.type === 'approval_requested')!
    provider.respondToApproval(task.id, ask.type === 'approval_requested' ? ask.approvalId : '', 'deny')
    expect(provider.result(task.id)).toEqual({ outcome: 'failed', error: 'Approval denied (simulated)' })
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
