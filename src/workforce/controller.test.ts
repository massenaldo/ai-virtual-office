import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkforceController, type WorkforceController } from './controller'
import { ClaudeRuntimeProvider, CLAUDE_UNAVAILABLE } from './runtime/claudeRuntime'
import { MOCK_ERROR_MESSAGE, MockRuntimeProvider } from './runtime/mockRuntime'
import type { RuntimeProvider } from './runtime/types'
import { WORKFORCE_STORAGE_KEY } from './storage'

const NOW = '2026-10-30T09:00:00.000Z'
const now = () => NOW

function memoryStorage() {
  const data = new Map<string, string>()
  const writes: string[] = []
  return { data, writes, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v) } }
}

let c: WorkforceController
let storage: ReturnType<typeof memoryStorage>
let runtime: MockRuntimeProvider

beforeEach(() => {
  vi.useFakeTimers()
  storage = memoryStorage()
  runtime = new MockRuntimeProvider()
  c = createWorkforceController({ storage, now, runtime })
})

afterEach(() => {
  c.dispose()
  vi.useRealTimers()
})

const state = () => c.getSnapshot().state
const task = (agentId: string) => state().tasks.filter((t) => t.agentId === agentId).at(-1)
const agent = (id: string) => state().agents.find((a) => a.id === id)
const saved = () => JSON.parse(storage.data.get(WORKFORCE_STORAGE_KEY)!)

describe('createWorkforceController', () => {
  it('seeds the demo without saving until the first change', () => {
    expect(state().agents).toHaveLength(6)
    expect(storage.data.has(WORKFORCE_STORAGE_KEY)).toBe(false)
    const r = c.createAgent({ name: 'Nova', role: 'Planner', department: 'design' })
    expect(r.ok).toBe(true)
    expect(saved().agents).toHaveLength(7)
    expect(c.getSnapshot()).toMatchObject({ loadProblem: null, saveError: null })
  })

  it('snapshot is stable until a change', () => {
    const calls = vi.fn()
    c.subscribe(calls)
    const before = c.getSnapshot()
    expect(c.getSnapshot()).toBe(before)
    expect(c.updateAgent('agent-demo-pm', { name: 'Atlas' })).toEqual({ ok: true })
    expect(calls).not.toHaveBeenCalled()
    expect(c.getSnapshot()).toBe(before)
    c.updateAgent('agent-demo-pm', { name: 'Atlas Two' })
    expect(calls).toHaveBeenCalledTimes(1)
    expect(c.getSnapshot()).not.toBe(before)
  })

  it('unsubscribe stops notifications', () => {
    const calls = vi.fn()
    const off = c.subscribe(calls)
    off()
    c.restoreDemoAgents()
    c.updateAgent('agent-demo-pm', { role: 'Planner' })
    expect(calls).not.toHaveBeenCalled()
  })

  it('startTask runs the simulated lifecycle and saves each step', () => {
    expect(c.startTask('agent-demo-backend', { title: 'Build API', description: '' })).toEqual({ ok: true })
    expect(task('agent-demo-backend')?.status).toBe('queued')
    vi.advanceTimersByTime(0)
    expect(agent('agent-demo-backend')?.status).toBe('thinking')
    vi.advanceTimersByTime(6000)
    expect(task('agent-demo-backend')).toMatchObject({ status: 'completed', resultSummary: 'Simulated result for "Build API". No AI was run.' })
    expect(saved().tasks[0].status).toBe('completed')
  })

  it('an event between actions is not lost', () => {
    c.startTask('agent-demo-backend', { title: 'Build API', description: '' })
    vi.advanceTimersByTime(0)
    const r = c.createAgent({ name: 'Nova', role: 'Planner', department: 'design' })
    expect(r.ok).toBe(true)
    expect(task('agent-demo-backend')?.status).toBe('running')
    expect(state().agents).toHaveLength(7)
    vi.advanceTimersByTime(2000)
    expect(agent('agent-demo-backend')?.status).toBe('working')
    expect(state().agents).toHaveLength(7)
  })

  it('a refused start fails the task', () => {
    c.dispose()
    c = createWorkforceController({ storage, now, runtime: new ClaudeRuntimeProvider() })
    expect(c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })).toEqual({ ok: true })
    expect(task('agent-demo-qa')).toMatchObject({ status: 'failed', errorMessage: CLAUDE_UNAVAILABLE })
    expect(agent('agent-demo-qa')?.status).toBe('error')
    expect(state().activities.at(-1)).toMatchObject({ type: 'task-failed', source: 'real' })
    expect(c.startTask('agent-demo-qa', { title: 'Again', description: '' })).toEqual({ ok: true })
  })

  it('startTask reports validation and active-task errors', () => {
    expect(c.startTask('agent-demo-qa', { title: '  ', description: '' })).toEqual({ ok: false, error: 'Title is required.' })
    c.startTask('agent-demo-qa', { title: 'One', description: '' })
    expect(c.startTask('agent-demo-qa', { title: 'Two', description: '' })).toEqual({ ok: false, error: 'Sentry already has an active task.' })
  })

  it('cancelTask ends a task the runtime lost', () => {
    c.dispose()
    const silent: RuntimeProvider = { mode: 'mock', availability: { available: true }, start: () => ({ ok: true, executionId: 'exec-x' }), cancel: () => {}, subscribe: () => () => {}, dispose: () => {} }
    c = createWorkforceController({ storage, now, runtime: silent })
    c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })
    const id = task('agent-demo-qa')!.id
    c.cancelTask(id)
    expect(task('agent-demo-qa')?.status).toBe('cancelled')
    expect(agent('agent-demo-qa')?.status).toBe('idle')
  })

  it('cancelTask stops a mock run', () => {
    c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })
    vi.advanceTimersByTime(1000)
    c.cancelTask(task('agent-demo-qa')!.id)
    vi.advanceTimersByTime(10000)
    expect(task('agent-demo-qa')?.status).toBe('cancelled')
    expect(runtime.activeTaskIds()).toEqual([])
  })

  it('removeAgent cancels its run', () => {
    c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })
    vi.advanceTimersByTime(1000)
    c.removeAgent('agent-demo-qa')
    vi.advanceTimersByTime(10000)
    expect(agent('agent-demo-qa')).toBeUndefined()
    expect(state().tasks.filter((t) => t.agentId === 'agent-demo-qa')).toEqual([])
    expect(runtime.activeTaskIds()).toEqual([])
  })

  it('demo controls drive waiting and error', () => {
    c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })
    vi.advanceTimersByTime(500)
    const id = task('agent-demo-qa')!.id
    c.forceWaiting(id)
    expect(agent('agent-demo-qa')?.status).toBe('waiting')
    c.resume(id)
    vi.advanceTimersByTime(4000)
    expect(agent('agent-demo-qa')?.status).toBe('completed')
    c.startTask('agent-demo-qa', { title: 'Again', description: '' })
    vi.advanceTimersByTime(0)
    c.forceError(task('agent-demo-qa')!.id)
    expect(task('agent-demo-qa')).toMatchObject({ status: 'failed', errorMessage: MOCK_ERROR_MESSAGE })
    expect(agent('agent-demo-qa')?.status).toBe('error')
  })

  it('assignDesk and updateAgent pass through errors', () => {
    expect(c.assignDesk('agent-demo-pm', 'desk-05')).toEqual({ ok: false, error: 'That desk is already assigned to Meridian.' })
    expect(c.assignDesk('agent-demo-pm', 'desk-04')).toEqual({ ok: true })
    expect(agent('agent-demo-pm')?.deskId).toBe('desk-04')
    expect(c.updateAgent('agent-demo-pm', { name: '' })).toEqual({ ok: false, error: 'Name is required.' })
  })

  it('surfaces and clears save errors', () => {
    let fail = true
    const flaky = { getItem: () => null, setItem: () => { if (fail) { fail = false; throw new Error('Quota exceeded') } } }
    c.dispose()
    c = createWorkforceController({ storage: flaky, now, runtime: new MockRuntimeProvider() })
    c.updateAgent('agent-demo-pm', { role: 'Planner' })
    expect(c.getSnapshot().saveError).toBe('Quota exceeded')
    c.updateAgent('agent-demo-pm', { role: 'Planner two' })
    expect(c.getSnapshot().saveError).toBeNull()
  })

  it('works in memory without storage', () => {
    c.dispose()
    c = createWorkforceController({ storage: null, now, runtime: new MockRuntimeProvider() })
    expect(c.getSnapshot().loadProblem).toBe('unavailable')
    expect(state().agents).toHaveLength(0)
    expect(c.createAgent({ name: 'Nova', role: 'Planner', department: 'design' }).ok).toBe(true)
    expect(state().agents).toHaveLength(1)
    c.dismissLoadProblem()
    expect(c.getSnapshot().loadProblem).toBeNull()
  })

  it('dispose clears timers and does not save', () => {
    c.startTask('agent-demo-qa', { title: 'Run tests', description: '' })
    const writes = storage.writes.length
    c.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(storage.writes.length).toBe(writes)
  })

  it('restoreDemoAgents brings back removed demo agents', () => {
    c.removeAgent('agent-demo-qa')
    expect(agent('agent-demo-qa')).toBeUndefined()
    c.restoreDemoAgents()
    expect(agent('agent-demo-qa')).toMatchObject({ demo: true })
  })
})
