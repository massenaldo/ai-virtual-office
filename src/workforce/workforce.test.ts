import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from './demo'
import { applyRuntimeEvent, assignTask, markStarting, removeAgent } from './operations'
import { MockRuntimeProvider } from './runtime/mockRuntime'
import { parseWorkforce, serializeWorkforce } from './storage'
import type { WorkforceState } from './types'

const NOW = '2026-10-30T09:00:00.000Z'

let provider: MockRuntimeProvider
let state: WorkforceState

beforeEach(() => {
  vi.useFakeTimers()
  provider = new MockRuntimeProvider()
  state = createDemoWorkforce(NOW)
  provider.subscribe((e) => { state = applyRuntimeEvent(state, e, NOW, 'mock') })
})

afterEach(() => {
  provider.dispose()
  vi.useRealTimers()
})

function startTask(agentId: string): string {
  const r = assignTask(state, agentId, { title: 'Build API', description: 'REST endpoints' }, NOW)
  if (!r.ok) throw new Error(r.error)
  state = markStarting(r.state, r.taskId, NOW)
  const task = state.tasks.find((t) => t.id === r.taskId)!
  const agent = state.agents.find((a) => a.id === agentId)!
  const started = provider.start(task, agent)
  if (!started.ok) throw new Error(started.error)
  return r.taskId
}

describe('workforce end to end', () => {
  it('mock runtime events drive state end to end', () => {
    const taskId = startTask('agent-demo-backend')
    vi.advanceTimersByTime(6000)
    const task = state.tasks.find((t) => t.id === taskId)!
    expect(task).toMatchObject({ status: 'completed', resultSummary: 'Simulated result for "Build API". No AI was run.' })
    expect(task.executionId).toMatch(/^exec-/)
    expect(state.agents.find((a) => a.id === 'agent-demo-backend')).toMatchObject({ status: 'completed', currentTaskId: taskId })
    const trail = state.activities.filter((a) => a.taskId === taskId)
    expect(trail.map((a) => (a.type === 'task-progress' ? `progress:${a.step}` : a.type))).toEqual(['task-assigned', 'task-started', 'progress:thinking', 'progress:working', 'task-completed'])
    expect(trail.every((a) => a.source === 'mock')).toBe(true)
    expect(parseWorkforce(JSON.parse(serializeWorkforce(state)))).not.toBeNull()
  })

  it('removing an agent mid-run leaves no dangling references', () => {
    startTask('agent-demo-qa')
    vi.advanceTimersByTime(2500)
    const removed = removeAgent(state, 'agent-demo-qa')
    state = removed.state
    expect(removed.cancelledTaskId).not.toBeNull()
    provider.cancel(removed.cancelledTaskId!)
    const after = state
    vi.advanceTimersByTime(10000)
    expect(state).toBe(after)
    expect(provider.activeTaskIds()).toEqual([])
    expect(parseWorkforce(JSON.parse(serializeWorkforce(state)))).not.toBeNull()
  })
})
