import { DEPARTMENTS } from '../layout/catalog'
import { createId } from '../layout/operations'
import type { RuntimeEvent } from './runtime/types'
import { ACTIVITY_LIMIT, WORKFORCE_SCHEMA_VERSION, type ActivitySource, type Agent, type AgentActivity, type AgentDepartment, type AgentStatus, type AgentTask, type RuntimeMode, type WorkforceState } from './types'

// Every operation returns a new state, or the same reference when nothing changed.

export type AgentInput = { name: string; role: string; department: AgentDepartment }
export type TaskInput = { title: string; description: string }
export type OpResult<T = {}> = ({ ok: true; state: WorkforceState } & T) | { ok: false; error: string }

export const NAME_MAX = 40
export const ROLE_MAX = 60
export const TITLE_MAX = 80
export const DESCRIPTION_MAX = 1000
export const INTERRUPTED_MESSAGE = 'Interrupted by page reload (simulated run)'

// Distributes over the activity union so each variant keeps its own fields.
type NewActivity = AgentActivity extends infer A ? (A extends AgentActivity ? Omit<A, 'id'> : never) : never

export function emptyWorkforce(): WorkforceState {
  return { schemaVersion: WORKFORCE_SCHEMA_VERSION, agents: [], tasks: [], activities: [] }
}

const isAgentDepartment = (v: string): v is AgentDepartment => v !== 'meeting' && v in DEPARTMENTS

export function validateAgentInput(input: AgentInput): string | null {
  const name = input.name.trim()
  const role = input.role.trim()
  if (!name) return 'Name is required.'
  if (name.length > NAME_MAX) return `Name must be ${NAME_MAX} characters or fewer.`
  if (!role) return 'Role is required.'
  if (role.length > ROLE_MAX) return `Role must be ${ROLE_MAX} characters or fewer.`
  if (!isAgentDepartment(input.department)) return 'Choose a department.'
  return null
}

export function isActiveTask(t: AgentTask): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting'
}

export function agentAtDesk(s: WorkforceState, deskId: string): Agent | undefined {
  return s.agents.find((a) => a.deskId === deskId)
}

/** Appends one event, keeps the newest ACTIVITY_LIMIT, and stamps the agent's lastActivityAt. */
export function addActivity(s: WorkforceState, entry: NewActivity): WorkforceState {
  const activity = { ...entry, id: createId('activity', new Set(s.activities.map((a) => a.id))) } as AgentActivity
  const activities = [...s.activities, activity].slice(-ACTIVITY_LIMIT)
  const agents = s.agents.map((a) => (a.id === entry.agentId ? { ...a, lastActivityAt: entry.timestamp } : a))
  return { ...s, agents, activities }
}

function replaceAgent(s: WorkforceState, next: Agent): WorkforceState {
  return { ...s, agents: s.agents.map((a) => (a.id === next.id ? next : a)) }
}

const sourceOf = (a: Agent) => a.runtimeMode

export function createAgent(s: WorkforceState, input: AgentInput, now: string, opts: { runtimeMode?: RuntimeMode } = {}): OpResult<{ id: string }> {
  const error = validateAgentInput(input)
  if (error) return { ok: false, error }
  const id = createId('agent', new Set(s.agents.map((a) => a.id)))
  const agent: Agent = { id, name: input.name.trim(), role: input.role.trim(), department: input.department, deskId: null, status: 'idle', currentTaskId: null, runtimeMode: opts.runtimeMode ?? 'mock', demo: false, createdAt: now, lastActivityAt: null }
  const state = addActivity({ ...s, agents: [...s.agents, agent] }, { type: 'agent-created', agentId: id, taskId: null, message: `Agent "${agent.name}" created`, timestamp: now, source: sourceOf(agent) })
  return { ok: true, state, id }
}

export function updateAgent(s: WorkforceState, id: string, patch: Partial<AgentInput>, now: string): OpResult {
  const prev = s.agents.find((a) => a.id === id)
  if (!prev) return { ok: false, error: 'Agent not found.' }
  const input = { name: patch.name ?? prev.name, role: patch.role ?? prev.role, department: patch.department ?? prev.department }
  const error = validateAgentInput(input)
  if (error) return { ok: false, error }
  const next = { ...prev, name: input.name.trim(), role: input.role.trim(), department: input.department }
  if (next.name === prev.name && next.role === prev.role && next.department === prev.department) return { ok: true, state: s }
  const state = addActivity(replaceAgent(s, next), { type: 'agent-updated', agentId: id, taskId: null, message: `Agent "${next.name}" updated`, timestamp: now, source: sourceOf(next) })
  return { ok: true, state }
}

/** Drops the agent with its tasks and activities. The caller stops cancelledTaskId's run in the runtime. */
export function removeAgent(s: WorkforceState, id: string): { state: WorkforceState; cancelledTaskId: string | null } {
  if (!s.agents.some((a) => a.id === id)) return { state: s, cancelledTaskId: null }
  const active = s.tasks.find((t) => t.agentId === id && isActiveTask(t))
  const state = { ...s, agents: s.agents.filter((a) => a.id !== id), tasks: s.tasks.filter((t) => t.agentId !== id), activities: s.activities.filter((a) => a.agentId !== id) }
  return { state, cancelledTaskId: active?.id ?? null }
}

export function assignDesk(s: WorkforceState, agentId: string, deskId: string | null, now: string): OpResult {
  const prev = s.agents.find((a) => a.id === agentId)
  if (!prev) return { ok: false, error: 'Agent not found.' }
  if (prev.deskId === deskId) return { ok: true, state: s }
  const holder = deskId === null ? undefined : agentAtDesk(s, deskId)
  if (holder) return { ok: false, error: `That desk is already assigned to ${holder.name}.` }
  const base = { agentId, taskId: null, timestamp: now, source: sourceOf(prev) }
  const state = addActivity(
    replaceAgent(s, { ...prev, deskId }),
    deskId === null ? { ...base, type: 'desk-unassigned', message: 'Desk unassigned' } : { ...base, type: 'desk-assigned', deskId, message: `Assigned to desk ${deskId}` },
  )
  return { ok: true, state }
}

export function validateTaskInput(input: TaskInput): string | null {
  const title = input.title.trim()
  if (!title) return 'Title is required.'
  if (title.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`
  if (input.description.trim().length > DESCRIPTION_MAX) return `Description must be ${DESCRIPTION_MAX} characters or fewer.`
  return null
}

export function activeTaskFor(s: WorkforceState, agentId: string): AgentTask | undefined {
  return s.tasks.find((t) => t.agentId === agentId && isActiveTask(t))
}

/** Creates a queued task for the agent. One active task per agent; the runtime starts it separately. */
export function assignTask(s: WorkforceState, agentId: string, input: TaskInput, now: string): OpResult<{ taskId: string }> {
  const agent = s.agents.find((a) => a.id === agentId)
  if (!agent) return { ok: false, error: 'Agent not found.' }
  const error = validateTaskInput(input)
  if (error) return { ok: false, error }
  if (activeTaskFor(s, agentId)) return { ok: false, error: `${agent.name} already has an active task.` }
  const taskId = createId('task', new Set(s.tasks.map((t) => t.id)))
  const task: AgentTask = { id: taskId, agentId, title: input.title.trim(), description: input.description.trim(), status: 'queued', createdAt: now, startedAt: null, completedAt: null, resultSummary: null, errorMessage: null, executionId: null }
  const next = replaceAgent({ ...s, tasks: [...s.tasks, task] }, { ...agent, currentTaskId: taskId })
  const state = addActivity(next, { type: 'task-assigned', agentId, taskId, message: `Assigned "${task.title}"`, timestamp: now, source: sourceOf(agent) })
  return { ok: true, state, taskId }
}

type Transition = { task: Partial<AgentTask>; agentStatus: AgentStatus; activity: NewActivity }

function transitionFor(event: RuntimeEvent, task: AgentTask, now: string, source: ActivitySource): Transition {
  const base = { agentId: task.agentId, taskId: task.id, timestamp: now, source }
  switch (event.type) {
    case 'started':
      return { task: { status: 'running', startedAt: now, executionId: event.executionId }, agentStatus: 'thinking', activity: { ...base, type: 'task-started', message: `Started "${task.title}"` } }
    case 'progress':
      return { task: { status: 'running' }, agentStatus: event.step, activity: { ...base, type: 'task-progress', step: event.step, message: event.message } }
    case 'waiting':
      return { task: { status: 'waiting' }, agentStatus: 'waiting', activity: { ...base, type: 'task-waiting', message: event.message } }
    case 'completed':
      return { task: { status: 'completed', completedAt: now, resultSummary: event.summary }, agentStatus: 'completed', activity: { ...base, type: 'task-completed', message: event.summary } }
    case 'failed':
      return { task: { status: 'failed', completedAt: now, errorMessage: event.error }, agentStatus: 'error', activity: { ...base, type: 'task-failed', message: event.error } }
    case 'cancelled':
      return { task: { status: 'cancelled', completedAt: now }, agentStatus: 'idle', activity: { ...base, type: 'task-cancelled', message: `Cancelled "${task.title}"` } }
  }
}

function applyTransition(s: WorkforceState, task: AgentTask, t: Transition): WorkforceState {
  const tasks = s.tasks.map((x) => (x.id === task.id ? { ...x, ...t.task } : x))
  const agents = s.agents.map((a) => (a.id === task.agentId ? { ...a, status: t.agentStatus } : a))
  return addActivity({ ...s, tasks, agents }, t.activity)
}

/** The single place runtime events change state. Events for a missing or finished task are ignored, so late timers can't resurrect anything. */
export function applyRuntimeEvent(s: WorkforceState, event: RuntimeEvent, now: string, source: ActivitySource): WorkforceState {
  const task = s.tasks.find((t) => t.id === event.taskId)
  if (!task || !isActiveTask(task) || !s.agents.some((a) => a.id === task.agentId)) return s
  return applyTransition(s, task, transitionFor(event, task, now, source))
}

/** Ends an active task in state, whether or not a runtime still tracks it. Call it alongside runtime.cancel; the runtime's own cancelled event is then ignored. */
export function cancelTask(s: WorkforceState, taskId: string, now: string): WorkforceState {
  const task = s.tasks.find((t) => t.id === taskId)
  const agent = task && s.agents.find((a) => a.id === task.agentId)
  return agent ? applyRuntimeEvent(s, { type: 'cancelled', taskId }, now, sourceOf(agent)) : s
}

/** After a reload no timer is running any more, so started tasks are marked failed instead of hanging forever. Queued tasks never started and stay. */
export function recoverInterruptedTasks(s: WorkforceState, now: string): WorkforceState {
  return s.tasks.reduce((state, task) => {
    if (task.status !== 'running' && task.status !== 'waiting') return state
    const agent = state.agents.find((a) => a.id === task.agentId)
    const source = agent ? sourceOf(agent) : 'mock'
    return applyTransition(state, task, transitionFor({ type: 'failed', taskId: task.id, error: INTERRUPTED_MESSAGE }, task, now, source))
  }, s)
}
