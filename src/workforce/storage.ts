import { DEPARTMENTS } from '../layout/catalog'
import { createDemoWorkforce } from './demo'
import { emptyWorkforce, isActiveTask, recoverInterruptedTasks } from './operations'
import { ACTIVITY_LIMIT, WORKFORCE_SCHEMA_VERSION, type ActivityType, type Agent, type AgentActivity, type AgentStatus, type AgentTask, type TaskStatus, type WorkforceState } from './types'

// Kept apart from the layout key so agent changes can never overwrite the saved office.
export const WORKFORCE_STORAGE_KEY = 'ai-virtual-office:workforce:v1'
export const WORKFORCE_BACKUP_KEY = 'ai-virtual-office:workforce:v1:backup'

type KV = Pick<Storage, 'getItem' | 'setItem'>
export type WorkforceLoadProblem = 'corrupt' | 'unsupported-version' | 'unavailable'
export type WorkforceLoadResult = { state: WorkforceState; seeded: boolean; problem: WorkforceLoadProblem | null }

const AGENT_STATUSES: AgentStatus[] = ['idle', 'working', 'thinking', 'waiting', 'error', 'completed']
const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']
const MODES = ['mock', 'real']
const STEPS = ['thinking', 'working']
const AGENT_ACTIVITIES: ActivityType[] = ['agent-created', 'agent-updated', 'desk-assigned', 'desk-unassigned']
const TASK_ACTIVITIES: ActivityType[] = ['task-assigned', 'task-started', 'task-progress', 'task-waiting', 'task-completed', 'task-failed', 'task-cancelled']

/** JSON with a fixed key order per record and only the newest ACTIVITY_LIMIT activities. */
export function serializeWorkforce(s: WorkforceState): string {
  return JSON.stringify({
    schemaVersion: s.schemaVersion,
    agents: s.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, department: a.department, deskId: a.deskId, status: a.status, currentTaskId: a.currentTaskId, runtimeMode: a.runtimeMode, demo: a.demo, createdAt: a.createdAt, lastActivityAt: a.lastActivityAt })),
    tasks: s.tasks.map((t) => ({ id: t.id, agentId: t.agentId, title: t.title, description: t.description, status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt, resultSummary: t.resultSummary, errorMessage: t.errorMessage, executionId: t.executionId })),
    activities: s.activities.slice(-ACTIVITY_LIMIT).map((a) => ({
      id: a.id, agentId: a.agentId, taskId: a.taskId, type: a.type, message: a.message, timestamp: a.timestamp, source: a.source,
      ...(a.type === 'desk-assigned' ? { deskId: a.deskId } : {}),
      ...(a.type === 'task-progress' ? { step: a.step } : {}),
    })),
  })
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isTextOrNull = (v: unknown): v is string | null => v === null || isText(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isTimeOrNull = (v: unknown): v is string | null => v === null || isTime(v)
const isOneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && (values as readonly string[]).includes(v)

function parseAgent(v: unknown): Agent | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.name) || !isText(v.role) || typeof v.department !== 'string' || v.department === 'meeting' || !(v.department in DEPARTMENTS)) return null
  if (!isTextOrNull(v.deskId) || !isOneOf(v.status, AGENT_STATUSES) || !isTextOrNull(v.currentTaskId) || !isOneOf(v.runtimeMode, MODES) || typeof v.demo !== 'boolean' || !isTime(v.createdAt) || !isTimeOrNull(v.lastActivityAt)) return null
  return { id: v.id, name: v.name, role: v.role, department: v.department as Agent['department'], deskId: v.deskId, status: v.status, currentTaskId: v.currentTaskId, runtimeMode: v.runtimeMode as Agent['runtimeMode'], demo: v.demo, createdAt: v.createdAt, lastActivityAt: v.lastActivityAt }
}

function parseTask(v: unknown): AgentTask | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.agentId) || !isText(v.title) || typeof v.description !== 'string' || !isOneOf(v.status, TASK_STATUSES)) return null
  if (!isTime(v.createdAt) || !isTimeOrNull(v.startedAt) || !isTimeOrNull(v.completedAt) || !isTextOrNull(v.resultSummary) || !isTextOrNull(v.errorMessage) || !isTextOrNull(v.executionId)) return null
  return { id: v.id, agentId: v.agentId, title: v.title, description: v.description, status: v.status, createdAt: v.createdAt, startedAt: v.startedAt, completedAt: v.completedAt, resultSummary: v.resultSummary, errorMessage: v.errorMessage, executionId: v.executionId }
}

function parseActivity(v: unknown): AgentActivity | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.agentId) || !isTextOrNull(v.taskId) || typeof v.message !== 'string' || !isTime(v.timestamp) || !isOneOf(v.source, MODES)) return null
  const base = { id: v.id, agentId: v.agentId, taskId: v.taskId, message: v.message, timestamp: v.timestamp, source: v.source as AgentActivity['source'] }
  // Task events always name their task; agent events may or may not.
  if (isOneOf(v.type, TASK_ACTIVITIES) && base.taskId === null) return null
  if (v.type === 'desk-assigned') return isText(v.deskId) ? { ...base, type: v.type, deskId: v.deskId } : null
  if (v.type === 'task-progress') return isOneOf(v.step, STEPS) ? { ...base, type: v.type, step: v.step as 'thinking' | 'working' } : null
  if (isOneOf(v.type, AGENT_ACTIVITIES) || isOneOf(v.type, TASK_ACTIVITIES)) return { ...base, type: v.type } as AgentActivity
  return null
}

/** Strict check including cross-references. Anything invalid rejects the whole state rather than silently dropping parts of it. */
export function parseWorkforce(raw: unknown): WorkforceState | null {
  if (!isObject(raw) || raw.schemaVersion !== WORKFORCE_SCHEMA_VERSION || !Array.isArray(raw.agents) || !Array.isArray(raw.tasks) || !Array.isArray(raw.activities)) return null
  const agents = raw.agents.map(parseAgent)
  const tasks = raw.tasks.map(parseTask)
  const activities = raw.activities.map(parseActivity)
  if (agents.some((a) => !a) || tasks.some((t) => !t) || activities.some((a) => !a)) return null
  const state: WorkforceState = { schemaVersion: WORKFORCE_SCHEMA_VERSION, agents: agents as Agent[], tasks: tasks as AgentTask[], activities: activities as AgentActivity[] }

  const ids = [...state.agents, ...state.tasks, ...state.activities].map((o) => o.id)
  if (new Set(ids).size !== ids.length) return null
  const desks = state.agents.flatMap((a) => (a.deskId === null ? [] : [a.deskId]))
  if (new Set(desks).size !== desks.length) return null
  const agentIds = new Set(state.agents.map((a) => a.id))
  const taskById = new Map(state.tasks.map((t) => [t.id, t]))
  if (state.tasks.some((t) => !agentIds.has(t.agentId))) return null
  if (state.agents.some((a) => a.currentTaskId !== null && taskById.get(a.currentTaskId)?.agentId !== a.id)) return null
  if (state.agents.some((a) => state.tasks.filter((t) => t.agentId === a.id && isActiveTask(t)).length > 1)) return null
  if (state.activities.some((a) => !agentIds.has(a.agentId) || (a.taskId !== null && taskById.get(a.taskId)?.agentId !== a.agentId))) return null
  return state
}

function readStored(json: string): WorkforceState | null {
  try {
    return parseWorkforce(JSON.parse(json))
  } catch {
    return null
  }
}

/** Seeds the demo only when nothing was ever saved. Unreadable data is copied to the backup key once, and the app starts empty. */
export function loadWorkforce(storage: KV | null, now: string): WorkforceLoadResult {
  if (!storage) return { state: emptyWorkforce(), seeded: false, problem: 'unavailable' }
  let json: string | null
  try {
    json = storage.getItem(WORKFORCE_STORAGE_KEY)
  } catch {
    return { state: emptyWorkforce(), seeded: false, problem: 'unavailable' }
  }
  if (json === null) return { state: createDemoWorkforce(now), seeded: true, problem: null }
  const state = readStored(json)
  if (state) return { state: recoverInterruptedTasks(state, now), seeded: false, problem: null }

  let problem: WorkforceLoadProblem = 'corrupt'
  try {
    const raw: unknown = JSON.parse(json)
    if (isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > WORKFORCE_SCHEMA_VERSION) problem = 'unsupported-version'
  } catch {
    // Not JSON at all: corrupt.
  }
  try {
    if (storage.getItem(WORKFORCE_BACKUP_KEY) === null) storage.setItem(WORKFORCE_BACKUP_KEY, json)
  } catch {
    // The notice still shows; the original value stays under the main key until the next save.
  }
  return { state: emptyWorkforce(), seeded: false, problem }
}

export function saveWorkforce(storage: KV | null, s: WorkforceState): { ok: true } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: 'Browser storage is not available.' }
  const json = serializeWorkforce(s)
  if (!readStored(json)) return { ok: false, error: 'The workforce data failed validation and was not saved.' }
  try {
    storage.setItem(WORKFORCE_STORAGE_KEY, json)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Saving failed.' }
  }
}
