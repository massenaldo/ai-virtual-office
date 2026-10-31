import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentTask } from '../types'
import { MOCK_ERROR_MESSAGE, MOCK_TIMINGS, MockRuntimeProvider } from './mockRuntime'
import type { RuntimeEvent } from './types'

const NOW = '2026-10-30T09:00:00.000Z'
const agent: Agent = { id: 'agent-1', name: 'Forge', role: 'API engineer', department: 'backend', deskId: 'desk-07', status: 'idle', currentTaskId: 'task-1', runtimeMode: 'mock', demo: true, createdAt: NOW, lastActivityAt: null }
const task = (id = 'task-1'): AgentTask => ({ id, agentId: agent.id, title: 'Build API', description: '', status: 'queued', createdAt: NOW, startedAt: null, completedAt: null, resultSummary: null, errorMessage: null, executionId: null, timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: null, pendingApproval: null })

let provider: MockRuntimeProvider
let events: RuntimeEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  provider = new MockRuntimeProvider()
  events = []
  provider.subscribe((e) => events.push(e))
})

afterEach(() => {
  provider.dispose()
  vi.useRealTimers()
})

const types = () => events.map((e) => (e.type === 'progress' ? `progress:${e.step}` : e.type))

describe('MockRuntimeProvider', () => {
  it('reports itself as an available mock', () => {
    expect(provider.mode).toBe('mock')
    expect(provider.availability).toEqual({ available: true })
    expect(MOCK_TIMINGS).toEqual({ thinkingMs: 2000, workingMs: 4000 })
  })

  it('runs the full simulated lifecycle', () => {
    const r = provider.start(task(), agent)
    if (!r.ok) throw new Error(r.error)
    expect(events).toEqual([])
    vi.advanceTimersByTime(0)
    expect(events).toEqual([
      { type: 'started', taskId: 'task-1', executionId: r.executionId },
      { type: 'progress', taskId: 'task-1', step: 'thinking', message: 'Thinking (simulated)' },
    ])
    vi.advanceTimersByTime(2000)
    expect(events.at(-1)).toEqual({ type: 'progress', taskId: 'task-1', step: 'working', message: 'Working (simulated)' })
    vi.advanceTimersByTime(3999)
    expect(events).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(events.at(-1)).toEqual({ type: 'completed', taskId: 'task-1', summary: 'Simulated result for "Build API". No AI was run.' })
    expect(provider.activeTaskIds()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel stops pending timers', () => {
    provider.start(task(), agent)
    vi.advanceTimersByTime(1000)
    provider.cancel('task-1')
    expect(events.at(-1)).toEqual({ type: 'cancelled', taskId: 'task-1' })
    const count = events.length
    vi.advanceTimersByTime(10000)
    expect(events).toHaveLength(count)
    expect(provider.activeTaskIds()).toEqual([])
  })

  const requested = () => events.filter((e): e is Extract<RuntimeEvent, { type: 'approval_requested' }> => e.type === 'approval_requested').at(-1)!

  it('requestApproval then approve completes after workingMs', () => {
    provider.start(task(), agent)
    vi.advanceTimersByTime(500)
    provider.requestApproval('task-1')
    expect(requested()).toMatchObject({ type: 'approval_requested', taskId: 'task-1', tool: 'Write', summary: 'Simulated request to write a file' })
    expect(requested().approvalId).toMatch(/^approval-/)
    vi.advanceTimersByTime(60000)
    expect(types().at(-1)).toBe('approval_requested')
    expect(provider.activeTaskIds()).toEqual(['task-1'])
    provider.respondToApproval('task-1', requested().approvalId, 'approve')
    expect(types().at(-1)).toBe('progress:working')
    vi.advanceTimersByTime(3999)
    expect(types().at(-1)).toBe('progress:working')
    vi.advanceTimersByTime(1)
    expect(types().at(-1)).toBe('completed')
  })

  it('deny fails with the simulated message', () => {
    provider.start(task(), agent)
    vi.advanceTimersByTime(0)
    provider.requestApproval('task-1')
    provider.respondToApproval('task-1', requested().approvalId, 'deny')
    expect(events.at(-1)).toEqual({ type: 'failed', taskId: 'task-1', error: 'Approval denied (simulated)' })
    expect(provider.activeTaskIds()).toEqual([])
    vi.advanceTimersByTime(10000)
    expect(types().at(-1)).toBe('failed')
  })

  it('respondToApproval ignores a stale id and a second answer', () => {
    provider.start(task(), agent)
    vi.advanceTimersByTime(0)
    provider.requestApproval('task-1')
    const id = requested().approvalId
    const count = events.length
    provider.respondToApproval('task-1', 'approval-stale', 'approve')
    expect(events).toHaveLength(count)
    provider.respondToApproval('task-1', id, 'approve')
    provider.respondToApproval('task-1', id, 'deny')
    expect(types().slice(count)).toEqual(['progress:working'])
  })

  it('requestApproval does nothing unless running and not already waiting', () => {
    provider.requestApproval('task-1')
    expect(events).toEqual([])
    provider.start(task(), agent)
    vi.advanceTimersByTime(0)
    provider.requestApproval('task-1')
    provider.requestApproval('task-1')
    expect(types().filter((t) => t === 'approval_requested')).toHaveLength(1)
  })

  it('forceError emits failed with the default message', () => {
    provider.start(task(), agent)
    vi.advanceTimersByTime(0)
    provider.forceError('task-1')
    expect(events.at(-1)).toEqual({ type: 'failed', taskId: 'task-1', error: MOCK_ERROR_MESSAGE })
    expect(MOCK_ERROR_MESSAGE).toBe('Simulated error (demo control).')
    vi.advanceTimersByTime(10000)
    expect(types().at(-1)).toBe('failed')
  })

  it('ignores duplicate start and controls on finished tasks', () => {
    expect(provider.start(task(), agent).ok).toBe(true)
    expect(provider.start(task(), agent)).toEqual({ ok: false, error: 'Task is already running.' })
    vi.advanceTimersByTime(6000)
    const count = events.length
    provider.cancel('task-1')
    provider.forceError('task-1')
    provider.requestApproval('task-1')
    provider.respondToApproval('task-1', 'approval-x', 'approve')
    provider.cancel('task-unknown')
    expect(events).toHaveLength(count)
    expect(types().filter((t) => t === 'started')).toHaveLength(1)
  })

  it('runs separate tasks independently', () => {
    provider.start(task('task-1'), agent)
    provider.start(task('task-2'), { ...agent, id: 'agent-2' })
    vi.advanceTimersByTime(0)
    provider.cancel('task-1')
    vi.advanceTimersByTime(6000)
    expect(events.filter((e) => e.taskId === 'task-2').at(-1)?.type).toBe('completed')
    expect(events.filter((e) => e.taskId === 'task-1').at(-1)?.type).toBe('cancelled')
  })

  it('dispose clears timers', () => {
    provider.start(task(), agent)
    provider.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(events).toEqual([])
    expect(provider.activeTaskIds()).toEqual([])
  })

  it('unsubscribe stops delivery to that listener only', () => {
    const other: RuntimeEvent[] = []
    const off = provider.subscribe((e) => other.push(e))
    off()
    provider.start(task(), agent)
    vi.advanceTimersByTime(0)
    expect(other).toEqual([])
    expect(events).toHaveLength(2)
  })

  it('keeps delivering when one listener throws', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const quiet = new MockRuntimeProvider()
    const got: RuntimeEvent[] = []
    quiet.subscribe(() => { throw new Error('boom') })
    quiet.subscribe((e) => got.push(e))
    quiet.start(task(), agent)
    vi.advanceTimersByTime(0)
    expect(got).toHaveLength(2)
    expect(logged).toHaveBeenCalledTimes(2)
    logged.mockRestore()
    quiet.dispose()
  })

  it('accepts custom timings', () => {
    const fast = new MockRuntimeProvider({ timings: { thinkingMs: 10, workingMs: 20 } })
    const got: RuntimeEvent[] = []
    fast.subscribe((e) => got.push(e))
    fast.start(task(), agent)
    vi.advanceTimersByTime(30)
    expect(got.at(-1)?.type).toBe('completed')
    fast.dispose()
  })
})
