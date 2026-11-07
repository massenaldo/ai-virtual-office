import { describe, expect, it } from 'vitest'
import { activeTaskFor, clearAgentError, MODEL_NAME_PATTERN, validateAgentInput, addActivity, applyRuntimeEvent, assignDesk, assignTask, cancelTask, createAgent, decideApproval, emptyWorkforce, failHeldTask, HELD_RESTART_MESSAGE, INTERRUPTED_MESSAGE, markStarting, recoverInterruptedTasks, removeAgent, requestCancel, setTaskHold, timeOutTask, TIMEOUT_MESSAGE, updateAgent, type AgentInput } from './operations'
import { parseWorkforce, serializeWorkforce } from './storage'
import type { AgentTask, TaskHold, WorkforceState } from './types'

const NOW = '2026-10-30T09:00:00.000Z'
const LATER = '2026-10-30T09:05:00.000Z'
const NOVA: AgentInput = { name: 'Nova', role: 'Planner', department: 'project-management' }

function withAgent(input: AgentInput = NOVA, s: WorkforceState = emptyWorkforce()) {
  const r = createAgent(s, input, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: r.state, id: r.id }
}

function task(agentId: string, patch: Partial<AgentTask> = {}): AgentTask {
  return { id: 'task-1', agentId, title: 'Draft sprint plan', description: '', status: 'running', createdAt: NOW, startedAt: NOW, completedAt: null, resultSummary: null, errorMessage: null, executionId: 'exec-1', timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: null, usage: null, pendingApproval: null, hold: null, ...patch }
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
    for (const department of ['constructor', '__proto__', 'toString']) expect(createAgent(s, { ...NOVA, department: department as AgentInput['department'] }, NOW)).toEqual({ ok: false, error: 'Choose a department.' })
  })

  it.each(['kitchen', 'dining', 'prayer', 'meeting'])('refuses %s as an agent department', (department) => {
    expect(createAgent(emptyWorkforce(), { ...NOVA, department: department as AgentInput['department'] }, NOW)).toEqual({ ok: false, error: 'Choose a department.' })
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
    expect(state.tasks[0]).toMatchObject({ id: taskId, agentId, status: 'queued', title: 'Draft sprint plan', description: 'Two-week plan', createdAt: NOW, startedAt: null, completedAt: null, executionId: null, timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: null, usage: null, pendingApproval: null })
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
    expect(started.tasks[0]).toMatchObject({ status: 'running', startedAt: NOW, executionId: 'exec-9', sessionId: 'sess-1' })
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
    expect(done.agents[0]).toMatchObject({ status: 'idle', currentTaskId: taskId })
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

  describe('usage', () => {
    const usage = { turns: 3, costUsd: 0.0123 }
    it('is stored when a task completes or fails with it', () => {
      const { state, taskId } = running()
      expect(applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x', usage }, LATER, 'mock').tasks[0].usage).toEqual(usage)
      expect(applyRuntimeEvent(state, { type: 'failed', taskId, error: 'x', usage }, LATER, 'mock').tasks[0].usage).toEqual(usage)
    })

    it('stays null without it, and for a mock task', () => {
      const { state, taskId } = running()
      expect(state.tasks[0].usage).toBeNull()
      expect(applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x' }, LATER, 'mock').tasks[0].usage).toBeNull()
    })

    it.each([
      ['negative cost', { turns: 1, costUsd: -1 }],
      ['negative turns', { turns: -1, costUsd: 0 }],
      ['fractional turns', { turns: 1.5, costUsd: 0 }],
      ['NaN cost', { turns: 1, costUsd: NaN }],
      ['infinite cost', { turns: 1, costUsd: Infinity }],
      ['absurd cost', { turns: 1, costUsd: 1001 }],
      ['absurd turns', { turns: 1001, costUsd: 0 }],
      ['a string', { turns: '1', costUsd: '0.1' }],
      ['missing cost', { turns: 1 }],
    ])('ignores an invalid value (%s)', (_n, bad) => {
      const { state, taskId } = running()
      const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x', usage: bad as never }, LATER, 'mock')
      expect(done.tasks[0]).toMatchObject({ status: 'completed', usage: null })
    })

    it('keeps only the two numbers', () => {
      const { state, taskId } = running()
      const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x', usage: { ...usage, note: 'secret' } as never }, LATER, 'mock')
      expect(done.tasks[0].usage).toEqual(usage)
    })

    it('is not overwritten by a second event on a finished task', () => {
      const { state, taskId } = running()
      const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x', usage }, LATER, 'mock')
      expect(applyRuntimeEvent(done, { type: 'failed', taskId, error: 'late', usage: { turns: 9, costUsd: 9 } }, LATER, 'mock')).toBe(done)
    })
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

describe('approval digest', () => {
  it('carries the action digest from the event into the pending approval, or null', () => {
    const { state, taskId } = withTask()
    const running = applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'started', taskId, executionId: 'e' }, NOW, 'mock')
    const digest = 'ab'.repeat(32)
    expect(applyRuntimeEvent(running, { type: 'approval_requested', taskId, approvalId: 'a1', tool: 'Write', summary: 's', digest }, LATER, 'mock').tasks[0].pendingApproval).toMatchObject({ id: 'a1', digest })
    expect(applyRuntimeEvent(running, { type: 'approval_requested', taskId, approvalId: 'a1', tool: 'Write', summary: 's' }, LATER, 'mock').tasks[0].pendingApproval).toMatchObject({ digest: null })
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
      tasks: statuses.map((status, i) => task(ids[i], { id: `task-${i}`, status, pendingApproval: status === 'waiting_for_approval' ? { id: 'a1', tool: 'Write', summary: 'x', requestedAt: NOW, digest: null, review: null, onceOnly: false } : null, startedAt: status === 'queued' ? null : NOW })),
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

/** Every state the operations produce must survive a save and reload. */
const saveable = (s: WorkforceState) => parseWorkforce(JSON.parse(serializeWorkforce(s))) !== null

describe('states stay saveable', () => {
  it('cancelling from waiting_for_approval clears the approval', () => {
    const { state, taskId } = running()
    const cancelling = requestCancel(applyRuntimeEvent(state, approval(taskId), NOW, 'mock'), taskId, LATER, 'mock')
    expect(cancelling.tasks[0]).toMatchObject({ status: 'cancelling', pendingApproval: null })
    expect(saveable(cancelling)).toBe(true)
  })

  it('normalises empty strings in runtime events', () => {
    const { state: queued, taskId: qId } = withTask()
    const started = applyRuntimeEvent(markStarting(queued, qId, NOW), { type: 'started', taskId: qId, executionId: '', sessionId: '' }, LATER, 'mock')
    expect(started.tasks[0]).toMatchObject({ status: 'running', executionId: null, sessionId: null })
    expect(saveable(started)).toBe(true)
    const failed = applyRuntimeEvent(started, { type: 'failed', taskId: qId, error: '' }, LATER, 'mock')
    expect(failed.tasks[0].errorMessage).toBe('The runtime reported an error without a message.')
    expect(saveable(failed)).toBe(true)
    const { state, taskId } = running()
    const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: '' }, LATER, 'mock')
    expect(done.tasks[0]).toMatchObject({ status: 'completed', resultSummary: null })
    expect(saveable(done)).toBe(true)
  })

  it('ignores an approval request without an id or tool', () => {
    const { state, taskId } = running()
    expect(applyRuntimeEvent(state, { ...approval(taskId), approvalId: '' }, LATER, 'mock')).toBe(state)
    expect(applyRuntimeEvent(state, { ...approval(taskId), tool: '' }, LATER, 'mock')).toBe(state)
  })
})

describe('recoverInterruptedTasks message', () => {
  it('uses a given message and keeps the browser default otherwise', () => {
    const { state } = running()
    expect(recoverInterruptedTasks(state, LATER, 'Interrupted by a server restart').tasks[0]).toMatchObject({ status: 'failed', errorMessage: 'Interrupted by a server restart' })
    expect(recoverInterruptedTasks(state, LATER).tasks[0].errorMessage).toBe(INTERRUPTED_MESSAGE)
  })
})

describe('assignTask workspace id', () => {
  it('records a workspace id and defaults to null', () => {
    const { state, id } = withAgent()
    const withWs = assignTask(state, id, { title: 'Ok', description: '' }, NOW, { workspaceId: 'sandbox' })
    expect(withWs.ok && withWs.state.tasks[0].workspaceId).toBe('sandbox')
    const without = assignTask(state, id, { title: 'Ok', description: '' }, NOW)
    expect(without.ok && without.state.tasks[0].workspaceId).toBeNull()
  })
})


describe('activities are labelled by the runtime of the task, not of the agent', () => {
  const sources = (s: WorkforceState, taskId: string) => s.activities.filter((a) => a.taskId === taskId).map((a) => a.source)
  const setup = (agentMode: 'mock' | 'real', runtime: 'mock' | 'claude') => {
    const { state, id } = withAgent(NOVA, emptyWorkforce())
    const withMode = { ...state, agents: state.agents.map((a) => ({ ...a, runtimeMode: agentMode })) }
    const a = assignTask(withMode, id, { title: 'T', description: '' }, NOW, { runtime })
    if (!a.ok) throw new Error(a.error)
    return { s: a.state, taskId: a.taskId }
  }

  it.each([
    ['mock', 'claude', 'real'],
    ['real', 'mock', 'mock'],
    ['mock', 'mock', 'mock'],
    ['real', 'claude', 'real'],
  ] as const)('agent %s, task %s: assign, force-cancel and restart recovery say %s', (mode, runtime, expected) => {
    const { s, taskId } = setup(mode, runtime)
    expect(sources(s, taskId)).toEqual([expected])
    expect(sources(cancelTask(s, taskId, LATER), taskId).every((x) => x === expected)).toBe(true)
    const running = markStarting(s, taskId, NOW)
    const recovered = recoverInterruptedTasks(running, LATER, 'Interrupted')
    expect(recovered.tasks[0]!.status).toBe('failed')
    expect(sources(recovered, taskId).every((x) => x === expected)).toBe(true)
    const cancelling = requestCancel(markStarting(s, taskId, NOW), taskId, NOW, expected)
    expect(sources(recoverInterruptedTasks(cancelling, LATER), taskId).every((x) => x === expected)).toBe(true)
  })
})


describe('agent profile', () => {
  it('new agents get the defaults', () => {
    const { state } = withAgent()
    expect(state.agents[0]).toMatchObject({ description: '', instructions: '', model: null, takesPrayerBreaks: true, sourceFile: null })
  })

  it('createAgent stores trimmed-free profile fields as given', () => {
    const { state } = withAgent({ ...NOVA, description: 'Plans', instructions: 'Be brief.\nBe kind.', model: 'claude-sonnet-4-5', takesPrayerBreaks: false })
    expect(state.agents[0]).toMatchObject({ description: 'Plans', instructions: 'Be brief.\nBe kind.', model: 'claude-sonnet-4-5', takesPrayerBreaks: false, sourceFile: null })
  })

  it('createAgent stores sourceFile only when the caller passes it', () => {
    const s = emptyWorkforce()
    const r = createAgent(s, NOVA, NOW, { sourceFile: 'sandbox:nova.md' })
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents[0]!.sourceFile).toBe('sandbox:nova.md')
    expect(withAgent().state.agents[0]!.sourceFile).toBeNull()
  })

  it('validateAgentInput bounds the new fields', () => {
    expect(validateAgentInput({ ...NOVA, model: '-x' })).toMatch(/model/i)
    expect(validateAgentInput({ ...NOVA, model: 'a b' })).toMatch(/model/i)
    expect(validateAgentInput({ ...NOVA, model: 'a'.repeat(101) })).toMatch(/model/i)
    expect(validateAgentInput({ ...NOVA, model: null })).toBeNull()
    expect(validateAgentInput({ ...NOVA, model: 'claude-opus-4.5:x_y' })).toBeNull()
    expect(validateAgentInput({ ...NOVA, description: 'x'.repeat(500) })).toBeNull()
    expect(validateAgentInput({ ...NOVA, description: 'x'.repeat(501) })).toMatch(/500/)
    expect(validateAgentInput({ ...NOVA, instructions: 'x'.repeat(8192) })).toBeNull()
    expect(validateAgentInput({ ...NOVA, instructions: 'x'.repeat(8193) })).toMatch(/8192/)
    expect(validateAgentInput({ ...NOVA, instructions: 'a\nb\tc' })).toBeNull()
    for (const bad of ['a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb']) {
      expect(validateAgentInput({ ...NOVA, description: bad })).toMatch(/control/i)
      expect(validateAgentInput({ ...NOVA, instructions: bad })).toMatch(/control/i)
    }
    expect(MODEL_NAME_PATTERN.test('claude-x')).toBe(true)
  })

  it('updateAgent changes the new fields, and reports no change for identical values', () => {
    const { state, id } = withAgent()
    const r = updateAgent(state, id, { instructions: 'Do it', takesPrayerBreaks: false, model: 'm1' }, LATER)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents[0]).toMatchObject({ instructions: 'Do it', takesPrayerBreaks: false, model: 'm1' })
    expect(r.state.activities.at(-1)).toMatchObject({ type: 'agent-updated' })
    const same = updateAgent(r.state, id, { instructions: 'Do it', takesPrayerBreaks: false, model: 'm1' }, LATER)
    expect(same).toEqual({ ok: true, state: r.state })
    expect(updateAgent(r.state, id, { model: null }, LATER)).toMatchObject({ ok: true })
    expect(updateAgent(r.state, id, { model: 'bad model' }, LATER)).toMatchObject({ ok: false })
  })
})

describe('agent status after a task', () => {
  function runningTask() {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    return { state: applyRuntimeEvent(markStarting(r.state, r.taskId, NOW), { type: 'started', taskId: r.taskId, executionId: 'e' }, NOW, 'mock'), id, taskId: r.taskId }
  }
  it('completed returns the agent to idle and the task stays completed', () => {
    const { state, taskId } = runningTask()
    const done = applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'All done' }, LATER, 'mock')
    expect(done.agents[0].status).toBe('idle')
    expect(done.tasks[0]).toMatchObject({ status: 'completed', resultSummary: 'All done' })
  })
  it('failed leaves the agent in error', () => {
    const { state, taskId } = runningTask()
    expect(applyRuntimeEvent(state, { type: 'failed', taskId, error: 'boom' }, LATER, 'mock').agents[0].status).toBe('error')
  })
})

describe('clearAgentError', () => {
  function inError() {
    const { state, id, taskId } = (() => {
      const { state, id } = withAgent()
      const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
      if (!r.ok) throw new Error(r.error)
      return { state: r.state, id, taskId: r.taskId }
    })()
    return { id, state: applyRuntimeEvent(applyRuntimeEvent(markStarting(state, taskId, NOW), { type: 'started', taskId, executionId: 'e' }, NOW, 'mock'), { type: 'failed', taskId, error: 'boom' }, NOW, 'mock') }
  }
  it('sets error to idle and records an activity', () => {
    const { state, id } = inError()
    const r = clearAgentError(state, id, LATER)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents[0].status).toBe('idle')
    expect(r.state.tasks).toEqual(state.tasks)
  })
  it('changes nothing for any other status', () => {
    const { state, id } = withAgent()
    expect(clearAgentError(state, id, LATER)).toEqual({ ok: true, state })
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    const active = markStarting(r.state, r.taskId, NOW)
    const out = clearAgentError(active, id, LATER)
    expect(out).toEqual({ ok: true, state: active })
    expect(out.ok && out.state).toBe(active)
  })
  it('does not change an agent that is in error but has an active task', () => {
    const { state, id } = inError()
    const r = assignTask(state, id, { title: 'Next', description: '' }, LATER)
    if (!r.ok) throw new Error(r.error)
    const forced = { ...r.state, agents: r.state.agents.map((a) => ({ ...a, status: 'error' as const })) }
    const out = clearAgentError(forced, id, LATER)
    expect(out.ok && out.state).toBe(forced)
  })
  it('reports an unknown agent', () => {
    expect(clearAgentError(emptyWorkforce(), 'nope', LATER)).toEqual({ ok: false, error: 'Agent not found.' })
  })
})

describe('validateAgentInput name and role safety', () => {
  const base = NOVA
  it('refuses control characters in name and role', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0007b', 'a\u0085b']) {
      expect(validateAgentInput({ ...base, name: bad })).toMatch(/name/i)
      expect(validateAgentInput({ ...base, role: bad })).toMatch(/role/i)
    }
    expect(validateAgentInput(base)).toBeNull()
  })
})

describe('held tasks', () => {
  const HOLD: TaskHold = { label: 'On lunch', untilMs: 1_000_000, blockedBy: null }
  function held() {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'Write notes', description: '' }, NOW, { hold: HOLD })
    if (!r.ok) throw new Error(r.error)
    return { state: r.state, id, taskId: r.taskId }
  }
  it('assignTask stores the hold, stays queued and leaves the agent alone', () => {
    const { state, taskId } = held()
    expect(state.tasks[0]).toMatchObject({ id: taskId, status: 'queued', hold: HOLD })
    expect(state.agents[0].status).toBe('idle')
    expect(state.activities.at(-1)?.message).toBe('Assigned "Write notes"; it starts after the break')
  })
  it('an unheld task has hold null', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.tasks[0].hold).toBeNull()
    expect(r.state.activities.at(-1)?.message).toBe('Assigned "T"')
  })
  it('markStarting clears the hold and sets startedAt for a held and an unheld task', () => {
    const { state, taskId } = held()
    expect(markStarting(state, taskId, LATER).tasks[0]).toMatchObject({ status: 'starting', hold: null, startedAt: LATER })
    const { state: s2, id } = withAgent()
    const r = assignTask(s2, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(markStarting(r.state, r.taskId, LATER).tasks[0]).toMatchObject({ startedAt: LATER, hold: null })
  })
  it('an unheld task that never left queued has startedAt null, and started keeps the earlier startedAt', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.tasks[0].startedAt).toBeNull()
    const starting = markStarting(r.state, r.taskId, NOW)
    const running = applyRuntimeEvent(starting, { type: 'started', taskId: r.taskId, executionId: 'e' }, LATER, 'mock')
    expect(running.tasks[0]).toMatchObject({ status: 'running', startedAt: NOW })
  })
  it('cancelling a held task leaves an errored agent in error and an idle one idle', () => {
    const { state, taskId } = held()
    const errored = { ...state, agents: state.agents.map((a) => ({ ...a, status: 'error' as const })) }
    expect(requestCancel(errored, taskId, LATER, 'mock').agents[0].status).toBe('error')
    expect(requestCancel(state, taskId, LATER, 'mock').agents[0].status).toBe('idle')
  })
  it('cancelling a held task clears the hold and frees the agent', () => {
    const { state, taskId } = held()
    const next = requestCancel(state, taskId, LATER, 'mock')
    expect(next.tasks[0]).toMatchObject({ status: 'cancelled', hold: null })
    expect(next.agents[0].status).toBe('idle')
  })
  it('failHeldTask fails a held task with the message and the agent shows the error', () => {
    const { state, taskId } = held()
    const next = failHeldTask(state, taskId, LATER, 'Nope')
    expect(next.tasks[0]).toMatchObject({ status: 'failed', errorMessage: 'Nope', hold: null })
    expect(next.agents[0].status).toBe('error')
  })
  it('failHeldTask returns the same state for an unheld or unknown task', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(failHeldTask(r.state, r.taskId, LATER, 'x')).toBe(r.state)
    expect(failHeldTask(r.state, 'missing', LATER, 'x')).toBe(r.state)
  })
  it('setTaskHold changes the hold with no activity, and ignores an equal one', () => {
    const { state, taskId } = held()
    expect(setTaskHold(state, taskId, { ...HOLD })).toBe(state)
    const next = setTaskHold(state, taskId, { label: 'Praying', untilMs: 2_000_000, blockedBy: 'Waiting' })
    expect(next.tasks[0].hold).toEqual({ label: 'Praying', untilMs: 2_000_000, blockedBy: 'Waiting' })
    expect(next.activities).toEqual(state.activities)
    expect(setTaskHold(markStarting(state, taskId, LATER), taskId, HOLD)).toEqual(markStarting(state, taskId, LATER))
  })
  it('setTaskHold ignores a task that is not held', () => {
    const { state, id } = withAgent()
    const r = assignTask(state, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(setTaskHold(r.state, r.taskId, HOLD)).toBe(r.state)
  })
  it('recovery fails a held task with the restart sentence and leaves an unheld queued task', () => {
    expect(HELD_RESTART_MESSAGE).toBe('The server restarted while this task was waiting. Start it again.')
    const { state, taskId } = held()
    const next = recoverInterruptedTasks(state, LATER, 'Something else')
    expect(next.tasks[0]).toMatchObject({ id: taskId, status: 'failed', errorMessage: HELD_RESTART_MESSAGE, hold: null })
    expect(next.agents[0].status).toBe('error')
    const { state: s2, id } = withAgent()
    const r = assignTask(s2, id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(recoverInterruptedTasks(r.state, LATER)).toBe(r.state)
  })
  it('clearAgentError clears an errored agent that has a held task, but not one with another active task', () => {
    const { state, id } = held()
    const errored = { ...state, agents: state.agents.map((a) => ({ ...a, status: 'error' as const })) }
    const r = clearAgentError(errored, id, LATER)
    if (!r.ok) throw new Error(r.error)
    expect(r.state.agents[0].status).toBe('idle')
    const { state: s2, id: id2 } = withAgent()
    const a = assignTask(s2, id2, { title: 'T', description: '' }, NOW)
    if (!a.ok) throw new Error(a.error)
    const busy = { ...markStarting(a.state, a.taskId, NOW), agents: a.state.agents.map((x) => ({ ...x, status: 'error' as const })) }
    expect(clearAgentError(busy, id2, LATER)).toEqual({ ok: true, state: busy })
  })
})
