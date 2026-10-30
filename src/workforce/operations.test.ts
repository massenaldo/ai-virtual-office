import { describe, expect, it } from 'vitest'
import { activeTaskFor, addActivity, applyRuntimeEvent, assignDesk, assignTask, createAgent, emptyWorkforce, INTERRUPTED_MESSAGE, recoverInterruptedTasks, removeAgent, updateAgent, type AgentInput } from './operations'
import type { AgentTask, WorkforceState } from './types'

const NOW = '2026-10-30T09:00:00.000Z'
const LATER = '2026-10-30T09:05:00.000Z'
const NOVA: AgentInput = { name: 'Nova', role: 'Planner', department: 'project-management' }

function withAgent(input: AgentInput = NOVA, s: WorkforceState = emptyWorkforce()) {
  const r = createAgent(s, input, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: r.state, id: r.id }
}

function task(agentId: string, patch: Partial<AgentTask> = {}): AgentTask {
  return { id: 'task-1', agentId, title: 'Draft sprint plan', description: '', status: 'running', createdAt: NOW, startedAt: NOW, completedAt: null, resultSummary: null, errorMessage: null, executionId: 'exec-1', ...patch }
}

describe('createAgent', () => {
  it('trims and stores a new idle agent', () => {
    const r = createAgent(emptyWorkforce(), { name: '  Nova ', role: ' Planner ', department: 'project-management' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents).toHaveLength(1)
    expect(r.state.agents[0]).toMatchObject({ id: r.id, name: 'Nova', role: 'Planner', status: 'idle', deskId: null, currentTaskId: null, runtimeMode: 'mock', demo: false, createdAt: NOW })
    expect(r.state.activities).toHaveLength(1)
    expect(r.state.activities[0]).toMatchObject({ type: 'agent-created', agentId: r.id, taskId: null, source: 'mock', timestamp: NOW })
  })

  it('rejects whitespace-only and over-long names', () => {
    const s = emptyWorkforce()
    expect(createAgent(s, { ...NOVA, name: '   ' }, NOW)).toEqual({ ok: false, error: 'Name is required.' })
    expect(createAgent(s, { ...NOVA, name: 'x'.repeat(41) }, NOW)).toEqual({ ok: false, error: 'Name must be 40 characters or fewer.' })
    expect(createAgent(s, { ...NOVA, role: ' ' }, NOW)).toEqual({ ok: false, error: 'Role is required.' })
    expect(createAgent(s, { ...NOVA, role: 'x'.repeat(61) }, NOW)).toEqual({ ok: false, error: 'Role must be 60 characters or fewer.' })
    expect(createAgent(s, { ...NOVA, department: 'meeting' as AgentInput['department'] }, NOW)).toEqual({ ok: false, error: 'Choose a department.' })
  })

  it('records a real runtime mode when asked', () => {
    const r = createAgent(emptyWorkforce(), NOVA, NOW, { runtimeMode: 'real' })
    expect(r.ok && r.state.agents[0].runtimeMode).toBe('real')
  })
})

describe('updateAgent', () => {
  it('changes fields and logs agent-updated', () => {
    const { state, id } = withAgent()
    const r = updateAgent(state, id, { name: ' Nova Prime ', department: 'tech-lead' }, LATER)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents[0]).toMatchObject({ name: 'Nova Prime', role: 'Planner', department: 'tech-lead', lastActivityAt: LATER })
    expect(r.state.activities.at(-1)).toMatchObject({ type: 'agent-updated', agentId: id })
  })

  it('reports an unknown agent', () => {
    expect(updateAgent(emptyWorkforce(), 'agent-x', { name: 'A' }, NOW)).toEqual({ ok: false, error: 'Agent not found.' })
  })

  it('returns the same state when nothing changes', () => {
    const { state, id } = withAgent()
    const r = updateAgent(state, id, { name: 'Nova', role: ' Planner ' }, LATER)
    expect(r.ok && r.state).toBe(state)
  })

  it('validates the merged fields', () => {
    const { state, id } = withAgent()
    expect(updateAgent(state, id, { name: ' ' }, LATER)).toEqual({ ok: false, error: 'Name is required.' })
  })
})

describe('assignDesk', () => {
  it('enforces one agent per desk', () => {
    const a = withAgent({ ...NOVA, name: 'A' })
    const b = withAgent({ ...NOVA, name: 'B' }, a.state)
    const taken = assignDesk(b.state, a.id, 'desk-03', NOW)
    if (!taken.ok) throw new Error(taken.error)
    expect(taken.state.agents.find((x) => x.id === a.id)?.deskId).toBe('desk-03')
    expect(taken.state.activities.at(-1)).toMatchObject({ type: 'desk-assigned', deskId: 'desk-03', agentId: a.id })
    expect(assignDesk(taken.state, b.id, 'desk-03', NOW)).toEqual({ ok: false, error: 'That desk is already assigned to A.' })
    const again = assignDesk(taken.state, a.id, 'desk-03', NOW)
    expect(again.ok && again.state).toBe(taken.state)
    const freed = assignDesk(taken.state, a.id, null, LATER)
    if (!freed.ok) throw new Error(freed.error)
    expect(freed.state.agents.find((x) => x.id === a.id)?.deskId).toBeNull()
    expect(freed.state.activities.at(-1)).toMatchObject({ type: 'desk-unassigned', agentId: a.id })
  })

  it('reports an unknown agent', () => {
    expect(assignDesk(emptyWorkforce(), 'agent-x', 'desk-01', NOW)).toEqual({ ok: false, error: 'Agent not found.' })
  })
})

describe('removeAgent', () => {
  it('drops the agent with its tasks and activities and reports the active task', () => {
    const { state, id } = withAgent()
    const other = withAgent({ ...NOVA, name: 'Other' }, state)
    const s: WorkforceState = { ...other.state, tasks: [task(id)], agents: other.state.agents.map((a) => (a.id === id ? { ...a, status: 'working', currentTaskId: 'task-1' } : a)) }
    const r = removeAgent(s, id)
    expect(r.cancelledTaskId).toBe('task-1')
    expect(r.state.agents.map((a) => a.id)).toEqual([other.id])
    expect(r.state.tasks).toEqual([])
    expect(r.state.activities.every((a) => a.agentId !== id)).toBe(true)
  })

  it('reports no active task for a finished one', () => {
    const { state, id } = withAgent()
    const r = removeAgent({ ...state, tasks: [task(id, { status: 'completed' })] }, id)
    expect(r.cancelledTaskId).toBeNull()
  })

  it('returns the same state for an unknown id', () => {
    const s = emptyWorkforce()
    expect(removeAgent(s, 'agent-x')).toEqual({ state: s, cancelledTaskId: null })
    expect(removeAgent(s, 'agent-x').state).toBe(s)
  })
})

describe('addActivity', () => {
  it('keeps only the newest 300', () => {
    let { state, id } = withAgent()
    state = { ...state, activities: [] }
    for (let i = 1; i <= 305; i++) {
      state = addActivity(state, { type: 'agent-updated', agentId: id, taskId: null, message: `#${i}`, timestamp: `2026-10-30T10:00:${String(i % 60).padStart(2, '0')}.000Z`, source: 'mock' })
    }
    expect(state.activities).toHaveLength(300)
    expect(state.activities[0].message).toBe('#6')
    expect(state.agents[0].lastActivityAt).toBe(state.activities.at(-1)?.timestamp)
    expect(new Set(state.activities.map((a) => a.id)).size).toBe(300)
  })
})

function withTask(title = 'Draft sprint plan') {
  const { state, id } = withAgent()
  const r = assignTask(state, id, { title, description: 'Two-week plan' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: r.state, agentId: id, taskId: r.taskId }
}

describe('assignTask', () => {
  it('creates a queued task and points the agent at it', () => {
    const { state, agentId, taskId } = withTask()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: taskId, agentId, status: 'queued', title: 'Draft sprint plan', description: 'Two-week plan', createdAt: NOW, startedAt: null, completedAt: null, executionId: null })
    expect(state.agents[0]).toMatchObject({ currentTaskId: taskId, status: 'idle' })
    expect(state.activities.at(-1)).toMatchObject({ type: 'task-assigned', agentId, taskId })
    expect(activeTaskFor(state, agentId)?.id).toBe(taskId)
  })

  it('blocks a second active task', () => {
    const { state, agentId, taskId } = withTask()
    expect(assignTask(state, agentId, { title: 'Another', description: '' }, NOW)).toEqual({ ok: false, error: 'Nova already has an active task.' })
    const done = applyRuntimeEvent(applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'exec-1' }, NOW, 'mock'), { type: 'completed', taskId, summary: 'Done' }, NOW, 'mock')
    expect(activeTaskFor(done, agentId)).toBeUndefined()
    expect(assignTask(done, agentId, { title: 'Another', description: '' }, NOW).ok).toBe(true)
  })

  it('rejects blank or over-long titles and descriptions', () => {
    const { state, id } = withAgent()
    expect(assignTask(state, id, { title: '  ', description: '' }, NOW)).toEqual({ ok: false, error: 'Title is required.' })
    expect(assignTask(state, id, { title: 'x'.repeat(81), description: '' }, NOW)).toEqual({ ok: false, error: 'Title must be 80 characters or fewer.' })
    expect(assignTask(state, id, { title: 'Ok', description: 'x'.repeat(1001) }, NOW)).toEqual({ ok: false, error: 'Description must be 1000 characters or fewer.' })
    expect(assignTask(state, 'agent-x', { title: 'Ok', description: '' }, NOW)).toEqual({ ok: false, error: 'Agent not found.' })
  })
})

describe('applyRuntimeEvent', () => {
  it('walks started → progress working → completed', () => {
    const { state, agentId, taskId } = withTask()
    const started = applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'exec-9' }, LATER, 'mock')
    expect(started.tasks[0]).toMatchObject({ status: 'running', startedAt: LATER, executionId: 'exec-9' })
    expect(started.agents[0].status).toBe('thinking')
    expect(started.activities.at(-1)).toMatchObject({ type: 'task-started', taskId, agentId, source: 'mock', message: 'Started "Draft sprint plan"' })

    const working = applyRuntimeEvent(started, { type: 'progress', taskId, step: 'working', message: 'Working (simulated)' }, LATER, 'mock')
    expect(working.tasks[0].status).toBe('running')
    expect(working.agents[0].status).toBe('working')
    expect(working.activities.at(-1)).toMatchObject({ type: 'task-progress', step: 'working', message: 'Working (simulated)' })

    const waiting = applyRuntimeEvent(working, { type: 'waiting', taskId, message: 'Waiting for input (simulated)' }, LATER, 'mock')
    expect(waiting.tasks[0].status).toBe('waiting')
    expect(waiting.agents[0].status).toBe('waiting')
    expect(waiting.activities.at(-1)).toMatchObject({ type: 'task-waiting' })

    const resumed = applyRuntimeEvent(waiting, { type: 'progress', taskId, step: 'working', message: 'Working (simulated)' }, LATER, 'mock')
    expect(resumed.tasks[0].status).toBe('running')

    const done = applyRuntimeEvent(resumed, { type: 'completed', taskId, summary: 'Simulated result' }, LATER, 'mock')
    expect(done.tasks[0]).toMatchObject({ status: 'completed', completedAt: LATER, resultSummary: 'Simulated result', errorMessage: null })
    expect(done.agents[0]).toMatchObject({ status: 'completed', currentTaskId: taskId, lastActivityAt: LATER })
    expect(done.activities.at(-1)).toMatchObject({ type: 'task-completed', message: 'Simulated result', source: 'mock' })
  })

  it('failed sets the agent to error', () => {
    const { state, taskId } = withTask()
    const s = applyRuntimeEvent(state, { type: 'failed', taskId, error: 'Simulated error' }, LATER, 'mock')
    expect(s.tasks[0]).toMatchObject({ status: 'failed', completedAt: LATER, errorMessage: 'Simulated error' })
    expect(s.agents[0].status).toBe('error')
    expect(s.activities.at(-1)).toMatchObject({ type: 'task-failed', message: 'Simulated error' })
  })

  it('cancelled returns the agent to idle', () => {
    const { state, taskId } = withTask()
    const s = applyRuntimeEvent(applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'e' }, NOW, 'mock'), { type: 'cancelled', taskId }, LATER, 'mock')
    expect(s.tasks[0]).toMatchObject({ status: 'cancelled', completedAt: LATER })
    expect(s.agents[0].status).toBe('idle')
    expect(s.activities.at(-1)).toMatchObject({ type: 'task-cancelled' })
  })

  it('ignores events for unknown, finished or removed tasks', () => {
    const { state, agentId, taskId } = withTask()
    const cancelled = applyRuntimeEvent(state, { type: 'cancelled', taskId }, LATER, 'mock')
    expect(applyRuntimeEvent(cancelled, { type: 'completed', taskId, summary: 'late' }, LATER, 'mock')).toBe(cancelled)
    expect(applyRuntimeEvent(cancelled, { type: 'started', taskId, executionId: 'e' }, LATER, 'mock')).toBe(cancelled)
    const removed = removeAgent(state, agentId).state
    expect(applyRuntimeEvent(removed, { type: 'progress', taskId, step: 'working', message: 'x' }, LATER, 'mock')).toBe(removed)
    expect(applyRuntimeEvent(state, { type: 'completed', taskId: 'task-x', summary: 'x' }, LATER, 'mock')).toBe(state)
  })
})

describe('recoverInterruptedTasks', () => {
  it('fails running and waiting tasks only', () => {
    const a = withAgent({ ...NOVA, name: 'A' })
    const b = withAgent({ ...NOVA, name: 'B' }, a.state)
    const c = withAgent({ ...NOVA, name: 'C' }, b.state)
    const s: WorkforceState = {
      ...c.state,
      tasks: [task(a.id, { id: 'task-a', status: 'running' }), task(b.id, { id: 'task-b', status: 'waiting' }), task(c.id, { id: 'task-c', status: 'queued', startedAt: null, executionId: null })],
      agents: c.state.agents.map((x) => ({ ...x, status: x.id === b.id ? 'waiting' : x.id === a.id ? 'working' : 'idle', currentTaskId: x.id === a.id ? 'task-a' : x.id === b.id ? 'task-b' : 'task-c' })),
    }
    const r = recoverInterruptedTasks(s, LATER)
    expect(r.tasks.map((t) => t.status)).toEqual(['failed', 'failed', 'queued'])
    expect(r.tasks[0]).toMatchObject({ errorMessage: 'Interrupted by page reload (simulated run)', completedAt: LATER })
    expect(INTERRUPTED_MESSAGE).toBe('Interrupted by page reload (simulated run)')
    expect(r.agents.map((x) => x.status)).toEqual(['error', 'error', 'idle'])
    expect(r.activities.filter((x) => x.type === 'task-failed')).toHaveLength(2)
  })

  it('returns the same state when nothing is running', () => {
    const { state } = withTask()
    expect(recoverInterruptedTasks(state, LATER)).toBe(state)
  })
})
