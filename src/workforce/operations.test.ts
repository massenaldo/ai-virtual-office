import { describe, expect, it } from 'vitest'
import { addActivity, assignDesk, createAgent, emptyWorkforce, removeAgent, updateAgent, type AgentInput } from './operations'
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
