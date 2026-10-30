import { describe, expect, it } from 'vitest'
import { activeTaskFor, addActivity, applyRuntimeEvent, assignDesk, assignTask, cancelTask, createAgent, decideApproval, emptyWorkforce, INTERRUPTED_MESSAGE, markStarting, recoverInterruptedTasks, removeAgent, requestCancel, timeOutTask, TIMEOUT_MESSAGE, updateAgent, type AgentInput } from './operations'
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
  return { id: 'task-1', agentId, title: 'Draft sprint plan', description: '', status: 'running', createdAt: NOW, startedAt: NOW, completedAt: null, resultSummary: null, errorMessage: null, executionId: 'exec-1', timeoutMs: null, runtime: 'mock', sessionId: null, endedReason: null, pendingApproval: null, ...patch }
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

/** A task that has been started and reported running. */
function running() {
  const { state, agentId, taskId } = withTask()
  const s = applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'started', taskId, executionId: 'exec-9', sessionId: 'sess-1' }, NOW, 'mock')
  return { state: s, agentId, taskId }
}

const approval = (taskId: string, approvalId = 'approval-1') => ({ type: 'approval_requested' as const, taskId, approvalId, tool: 'Write', summary: 'Simulated request to write a file' })

describe('assignTask', () => {
  it('creates a queued v2 task and points the agent at it', () => {
    const { state, agentId, taskId } = withTask()
    expect(state.tasks[0]).toMatchObject({ id: taskId, agentId, status: 'queued', title: 'Draft sprint plan', description: 'Two-week plan', createdAt: NOW, startedAt: null, completedAt: null, executionId: null, timeoutMs: null, runtime: 'mock', sessionId: null, endedReason: null, pendingApproval: null })
    expect(state.agents[0]).toMatchObject({ currentTaskId: taskId, status: 'idle' })
    expect(state.activities.at(-1)).toMatchObject({ type: 'task-assigned', agentId, taskId })
    expect(activeTaskFor(state, agentId)?.id).toBe(taskId)
  })

  it('records the runtime and timeout when given', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'Ok', description: '' }, NOW, { runtime: 'claude', timeoutMs: 600000 })
    expect(r.ok && r.state.tasks[0]).toMatchObject({ runtime: 'claude', timeoutMs: 600000 })
  })

  it('blocks a second task while one is active in any active state', () => {
    const { state, agentId, taskId } = running()
    const blocked = (s: typeof state) => assignTask(s, agentId, { title: 'Another', description: '' }, NOW)
    expect(blocked(state)).toEqual({ ok: false, error: 'Nova already has an active task.' })
    expect(blocked(applyRuntimeEvent(state, approval(taskId), NOW, 'mock')).ok).toBe(false)
    expect(blocked(requestCancel(state, taskId, NOW, 'mock')).ok).toBe(false)
    const q = withTask()
    expect(assignTask(markStarting(q.state, q.taskId, NOW), q.agentId, { title: 'Another', description: '' }, NOW).ok).toBe(false)
    const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'Done' }, NOW, 'mock')
    expect(blocked(done).ok).toBe(true)
  })

  it('rejects blank or over-long titles and descriptions', () => {
    const { state, id } = withAgent()
    expect(assignTask(state, id, { title: '  ', description: '' }, NOW)).toEqual({ ok: false, error: 'Title is required.' })
    expect(assignTask(state, id, { title: 'x'.repeat(81), description: '' }, NOW)).toEqual({ ok: false, error: 'Title must be 80 characters or fewer.' })
    expect(assignTask(state, id, { title: 'Ok', description: 'x'.repeat(1001) }, NOW)).toEqual({ ok: false, error: 'Description must be 1000 characters or fewer.' })
    expect(assignTask(state, 'agent-x', { title: 'Ok', description: '' }, NOW)).toEqual({ ok: false, error: 'Agent not found.' })
  })
})

describe('markStarting', () => {
  it('moves queued to starting and the agent to thinking', () => {
    const { state, taskId } = withTask()
    const s = markStarting(state, taskId, LATER)
    expect(s.tasks[0].status).toBe('starting')
    expect(s.agents[0].status).toBe('thinking')
    expect(markStarting(s, taskId, LATER)).toBe(s)
    expect(markStarting(state, 'task-x', LATER)).toBe(state)
  })
})

describe('applyRuntimeEvent', () => {
  it('walks starting → started → progress → approval → approve → completed', () => {
    const { state, agentId, taskId } = withTask()
    const started = applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'started', taskId, executionId: 'exec-9', sessionId: 'sess-1' }, LATER, 'mock')
    expect(started.tasks[0]).toMatchObject({ status: 'running', startedAt: LATER, executionId: 'exec-9', sessionId: 'sess-1' })
    expect(started.agents[0].status).toBe('thinking')
    expect(started.activities.at(-1)).toMatchObject({ type: 'task-started', taskId, agentId, source: 'mock', message: 'Started "Draft sprint plan"' })

    const working = applyRuntimeEvent(started, { type: 'progress', taskId, step: 'working', message: 'Working (simulated)' }, LATER, 'mock')
    expect(working.agents[0].status).toBe('working')
    expect(working.activities.at(-1)).toMatchObject({ type: 'task-progress', step: 'working' })

    const waiting = applyRuntimeEvent(working, approval(taskId), LATER, 'mock')
    expect(waiting.tasks[0]).toMatchObject({ status: 'waiting_for_approval', pendingApproval: { id: 'approval-1', tool: 'Write', summary: 'Simulated request to write a file', requestedAt: LATER } })
    expect(waiting.agents[0].status).toBe('waiting')
    expect(waiting.activities.at(-1)).toMatchObject({ type: 'task-approval-requested', approvalId: 'approval-1', message: 'Approval needed: Simulated request to write a file' })

    const approved = decideApproval(waiting, taskId, 'approval-1', 'approve', LATER, 'mock')
    expect(approved.tasks[0]).toMatchObject({ status: 'running', pendingApproval: null })
    expect(approved.agents[0].status).toBe('working')
    expect(approved.activities.at(-1)).toMatchObject({ type: 'task-approval-decided', approvalId: 'approval-1', decision: 'approve', message: 'Approved: Simulated request to write a file' })

    const done = applyRuntimeEvent(approved, { type: 'completed', taskId, summary: 'Simulated result' }, LATER, 'mock')
    expect(done.tasks[0]).toMatchObject({ status: 'completed', completedAt: LATER, resultSummary: 'Simulated result', endedReason: 'completed', pendingApproval: null })
    expect(done.agents[0]).toMatchObject({ status: 'completed', currentTaskId: taskId })
  })

  it('ignores out-of-order events', () => {
    const { state: queued, taskId: qId } = withTask()
    expect(applyRuntimeEvent(queued, { type: 'started', taskId: qId, executionId: 'e' }, LATER, 'mock')).toBe(queued)
    const { state, taskId } = running()
    expect(applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'e2' }, LATER, 'mock')).toBe(state)
    const waiting = applyRuntimeEvent(state, approval(taskId), LATER, 'mock')
    expect(applyRuntimeEvent(waiting, approval(taskId, 'approval-2'), LATER, 'mock')).toBe(waiting)
    expect(applyRuntimeEvent(waiting, { type: 'progress', taskId, step: 'working', message: 'x' }, LATER, 'mock')).toBe(waiting)
    expect(applyRuntimeEvent(waiting, { type: 'message', taskId, text: 'x' }, LATER, 'mock')).toBe(waiting)
  })

  it('ends from waiting or cancelling with completed or failed', () => {
    const { state, taskId } = running()
    const waiting = applyRuntimeEvent(state, approval(taskId), LATER, 'mock')
    expect(applyRuntimeEvent(waiting, { type: 'failed', taskId, error: 'Approval denied (simulated)' }, LATER, 'mock').tasks[0]).toMatchObject({ status: 'failed', endedReason: 'failed', errorMessage: 'Approval denied (simulated)', pendingApproval: null })
    const cancelling = requestCancel(state, taskId, LATER, 'mock')
    expect(applyRuntimeEvent(cancelling, { type: 'completed', taskId, summary: 'raced' }, LATER, 'mock').tasks[0]).toMatchObject({ status: 'completed', endedReason: 'completed' })
  })

  it('a runtime may fail a task that is still starting', () => {
    const { state, taskId } = withTask()
    const s = applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'failed', taskId, error: 'Not available' }, LATER, 'real')
    expect(s.tasks[0]).toMatchObject({ status: 'failed', endedReason: 'failed', errorMessage: 'Not available' })
    expect(applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'completed', taskId, summary: 'x' }, LATER, 'mock').tasks[0].status).toBe('starting')
  })

  it('a message event logs agent-message without a status change', () => {
    const { state, taskId } = running()
    const s = applyRuntimeEvent(state, { type: 'message', taskId, text: 'Reading the spec' }, LATER, 'mock')
    expect(s.tasks[0].status).toBe('running')
    expect(s.agents[0].status).toBe('thinking')
    expect(s.activities.at(-1)).toMatchObject({ type: 'agent-message', message: 'Reading the spec', taskId })
  })

  it('failed sets the agent to error with a failed end reason', () => {
    const { state, taskId } = running()
    const s = applyRuntimeEvent(state, { type: 'failed', taskId, error: 'Simulated error' }, LATER, 'mock')
    expect(s.tasks[0]).toMatchObject({ status: 'failed', completedAt: LATER, errorMessage: 'Simulated error', endedReason: 'failed' })
    expect(s.agents[0].status).toBe('error')
  })

  it('ignores events for unknown, finished or removed tasks', () => {
    const { state, agentId, taskId } = running()
    const cancelled = applyRuntimeEvent(state, { type: 'cancelled', taskId }, LATER, 'mock')
    expect(applyRuntimeEvent(cancelled, { type: 'completed', taskId, summary: 'late' }, LATER, 'mock')).toBe(cancelled)
    const removed = removeAgent(state, agentId).state
    expect(applyRuntimeEvent(removed, { type: 'progress', taskId, step: 'working', message: 'x' }, LATER, 'mock')).toBe(removed)
    expect(applyRuntimeEvent(state, { type: 'completed', taskId: 'task-x', summary: 'x' }, LATER, 'mock')).toBe(state)
  })
})

describe('decideApproval', () => {
  it('ignores a stale id and a second decision', () => {
    const { state, taskId } = running()
    const waiting = applyRuntimeEvent(state, approval(taskId), LATER, 'mock')
    expect(decideApproval(waiting, taskId, 'approval-old', 'approve', LATER, 'mock')).toBe(waiting)
    const denied = decideApproval(waiting, taskId, 'approval-1', 'deny', LATER, 'mock')
    expect(denied.activities.at(-1)).toMatchObject({ type: 'task-approval-decided', decision: 'deny', message: 'Denied: Simulated request to write a file' })
    expect(decideApproval(denied, taskId, 'approval-1', 'approve', LATER, 'mock')).toBe(denied)
    expect(decideApproval(state, taskId, 'approval-1', 'approve', LATER, 'mock')).toBe(state)
  })
})

describe('requestCancel', () => {
  it('cancels a queued task at once', () => {
    const { state, taskId } = withTask()
    const s = requestCancel(state, taskId, LATER, 'mock')
    expect(s.tasks[0]).toMatchObject({ status: 'cancelled', endedReason: 'cancelled', completedAt: LATER })
    expect(s.agents[0].status).toBe('idle')
    expect(s.activities.at(-1)).toMatchObject({ type: 'task-cancelled' })
  })

  it('moves a started task to cancelling until the runtime confirms', () => {
    for (const make of [() => { const r = withTask(); return { ...r, state: markStarting(r.state, r.taskId, NOW) } }, running, () => { const r = running(); return { ...r, state: applyRuntimeEvent(r.state, approval(r.taskId), NOW, 'mock') } }]) {
      const { state, taskId } = make()
      const agentBefore = state.agents[0].status
      const cancelling = requestCancel(state, taskId, LATER, 'mock')
      expect(cancelling.tasks[0].status).toBe('cancelling')
      expect(cancelling.agents[0].status).toBe(agentBefore)
      expect(cancelling.activities.at(-1)).toMatchObject({ type: 'task-cancelling' })
      expect(requestCancel(cancelling, taskId, LATER, 'mock')).toBe(cancelling)
      const done = applyRuntimeEvent(cancelling, { type: 'cancelled', taskId }, LATER, 'mock')
      expect(done.tasks[0]).toMatchObject({ status: 'cancelled', endedReason: 'cancelled', pendingApproval: null })
      expect(done.agents[0].status).toBe('idle')
    }
  })

  it('does nothing for finished or unknown tasks', () => {
    const { state, taskId } = running()
    const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x' }, LATER, 'mock')
    expect(requestCancel(done, taskId, LATER, 'mock')).toBe(done)
    expect(requestCancel(state, 'task-x', LATER, 'mock')).toBe(state)
  })
})

describe('cancelTask', () => {
  it('forces any active task to cancelled', () => {
    const { state, agentId, taskId } = running()
    const s = cancelTask(requestCancel(state, taskId, LATER, 'mock'), taskId, LATER)
    expect(s.tasks[0]).toMatchObject({ status: 'cancelled', endedReason: 'cancelled' })
    expect(activeTaskFor(s, agentId)).toBeUndefined()
    expect(cancelTask(s, taskId, LATER)).toBe(s)
    expect(cancelTask(state, 'task-x', LATER)).toBe(state)
  })
})

describe('timeOutTask', () => {
  it('fails an active task with a timeout end reason', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'Slow', description: '' }, NOW, { timeoutMs: 600000 })
    if (!r.ok) throw new Error(r.error)
    const s = timeOutTask(markStarting(r.state, r.taskId, NOW), r.taskId, LATER, 'mock')
    expect(TIMEOUT_MESSAGE(600000)).toBe('Timed out after 600 s')
    expect(s.tasks[0]).toMatchObject({ status: 'failed', endedReason: 'timeout', errorMessage: 'Timed out after 600 s', completedAt: LATER })
    expect(s.agents[0].status).toBe('error')
    expect(s.activities.at(-1)).toMatchObject({ type: 'task-timed-out', message: 'Timed out after 600 s' })
    expect(timeOutTask(s, r.taskId, LATER, 'mock')).toBe(s)
  })

  it('uses a generic message without a configured timeout', () => {
    const { state, taskId } = running()
    expect(timeOutTask(state, taskId, LATER, 'mock').tasks[0].errorMessage).toBe('Timed out')
  })
})

describe('recoverInterruptedTasks', () => {
  it('fails started work, cancels cancelling work and keeps queued tasks', () => {
    const names = ['A', 'B', 'C', 'D', 'E']
    let s = emptyWorkforce()
    const ids: string[] = []
    for (const name of names) { const r = withAgent({ ...NOVA, name }, s); s = r.state; ids.push(r.id) }
    const statuses = ['starting', 'running', 'waiting_for_approval', 'cancelling', 'queued'] as const
    s = {
      ...s,
      tasks: statuses.map((status, i) => task(ids[i], { id: `task-${i}`, status, pendingApproval: status === 'waiting_for_approval' ? { id: 'a1', tool: 'Write', summary: 'x', requestedAt: NOW } : null, startedAt: status === 'queued' ? null : NOW })),
      agents: s.agents.map((a, i) => ({ ...a, currentTaskId: `task-${i}`, status: 'working' })),
    }
    const r = recoverInterruptedTasks(s, LATER)
    expect(r.tasks.map((t) => t.status)).toEqual(['failed', 'failed', 'failed', 'cancelled', 'queued'])
    expect(r.tasks[0]).toMatchObject({ errorMessage: INTERRUPTED_MESSAGE, endedReason: 'failed' })
    expect(r.tasks[2].pendingApproval).toBeNull()
    expect(r.agents.map((a) => a.status)).toEqual(['error', 'error', 'error', 'idle', 'working'])
  })

  it('returns the same state when nothing is running', () => {
    const { state } = withTask()
    expect(recoverInterruptedTasks(state, LATER)).toBe(state)
  })
})
