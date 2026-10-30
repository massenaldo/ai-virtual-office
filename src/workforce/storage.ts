import { DEPARTMENTS } from '../layout/catalog'
import { createDemoWorkforce } from './demo'
import { emptyWorkforce, isActiveTask, recoverInterruptedTasks } from './operations'
import { ACTIVITY_LIMIT, WORKFORCE_SCHEMA_VERSION, type ActivityType, type Agent, type AgentActivity, type AgentStatus, type AgentTask, type PendingApproval, type TaskEndReason, type TaskRuntime, type TaskStatus, type WorkforceState } from './types'

// Kept apart from the layout key so agent changes can never overwrite the saved office.
export const WORKFORCE_STORAGE_KEY = 'ai-virtual-office:workforce:v2'
export const WORKFORCE_BACKUP_KEY = 'ai-virtual-office:workforce:v2:backup'
/** Schema v1 data from milestone 3A: read once for migration, never written or removed, so it doubles as a backup. */
export const WORKFORCE_V1_KEY = 'ai-virtual-office:workforce:v1'

// Structural, so this module also type-checks without the DOM library (the backend imports it).
type KV = { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type WorkforceLoadProblem = 'corrupt' | 'unsupported-version' | 'unavailable'
/** What happened to stored data that couldn't be read, so the notice can say exactly that. */
export type Preserved = 'backup-created' | 'backup-exists' | 'left-in-place'
export type WorkforceLoadResult = { state: WorkforceState; seeded: boolean; migrated: boolean; problem: WorkforceLoadProblem | null; preserved: Preserved | null }

const AGENT_STATUSES: AgentStatus[] = ['idle', 'working', 'thinking', 'waiting', 'error', 'completed']
const TASK_STATUSES: TaskStatus[] = ['queued', 'starting', 'running', 'waiting_for_approval', 'completed', 'failed', 'cancelling', 'cancelled']
const TASK_RUNTIMES: TaskRuntime[] = ['mock', 'claude']
const END_REASONS: TaskEndReason[] = ['completed', 'failed', 'cancelled', 'timeout']
const DECISIONS = ['approve', 'deny']
const MODES = ['mock', 'real']
const STEPS = ['thinking', 'working']
const AGENT_ACTIVITIES: ActivityType[] = ['agent-created', 'agent-updated', 'desk-assigned', 'desk-unassigned']
const TASK_ACTIVITIES: ActivityType[] = ['task-assigned', 'task-started', 'task-progress', 'task-approval-requested', 'task-approval-decided', 'task-completed', 'task-failed', 'task-cancelling', 'task-cancelled', 'task-timed-out', 'agent-message']

/** JSON with a fixed key order per record and only the newest ACTIVITY_LIMIT activities. */
export function serializeWorkforce(s: WorkforceState): string {
  return JSON.stringify({
    schemaVersion: s.schemaVersion,
    agents: s.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, department: a.department, deskId: a.deskId, status: a.status, currentTaskId: a.currentTaskId, runtimeMode: a.runtimeMode, demo: a.demo, createdAt: a.createdAt, lastActivityAt: a.lastActivityAt })),
    tasks: s.tasks.map((t) => ({ id: t.id, agentId: t.agentId, title: t.title, description: t.description, status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt, resultSummary: t.resultSummary, errorMessage: t.errorMessage, executionId: t.executionId, timeoutMs: t.timeoutMs, runtime: t.runtime, workspaceId: t.workspaceId, sessionId: t.sessionId, endedReason: t.endedReason, pendingApproval: t.pendingApproval && { id: t.pendingApproval.id, tool: t.pendingApproval.tool, summary: t.pendingApproval.summary, requestedAt: t.pendingApproval.requestedAt } })),
    activities: s.activities.slice(-ACTIVITY_LIMIT).map((a) => ({
      id: a.id, agentId: a.agentId, taskId: a.taskId, type: a.type, message: a.message, timestamp: a.timestamp, source: a.source,
      ...(a.type === 'desk-assigned' ? { deskId: a.deskId } : {}),
      ...(a.type === 'task-progress' ? { step: a.step } : {}),
      ...(a.type === 'task-approval-requested' ? { approvalId: a.approvalId } : {}),
      ...(a.type === 'task-approval-decided' ? { approvalId: a.approvalId, decision: a.decision } : {}),
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

function parseApproval(v: unknown): PendingApproval | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.tool) || typeof v.summary !== 'string' || !isTime(v.requestedAt)) return null
  return { id: v.id, tool: v.tool, summary: v.summary, requestedAt: v.requestedAt }
}

function parseTask(v: unknown): AgentTask | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.agentId) || !isText(v.title) || typeof v.description !== 'string' || !isOneOf(v.status, TASK_STATUSES)) return null
  if (!isTime(v.createdAt) || !isTimeOrNull(v.startedAt) || !isTimeOrNull(v.completedAt) || !isTextOrNull(v.resultSummary) || !isTextOrNull(v.errorMessage) || !isTextOrNull(v.executionId)) return null
  if (!(v.timeoutMs === null || (Number.isInteger(v.timeoutMs) && (v.timeoutMs as number) > 0)) || !isOneOf(v.runtime, TASK_RUNTIMES) || !isTextOrNull(v.sessionId)) return null
  // Saved before workspaces existed: no field means no workspace.
  const workspaceId = v.workspaceId === undefined ? null : v.workspaceId
  if (!isTextOrNull(workspaceId)) return null
  const status = v.status
  const active = status === 'queued' || status === 'starting' || status === 'running' || status === 'waiting_for_approval' || status === 'cancelling'
  // An end reason exactly when the task has ended; a pending approval exactly while it waits for one.
  if (active ? v.endedReason !== null : !isOneOf(v.endedReason, END_REASONS)) return null
  const pendingApproval = v.pendingApproval === null ? null : parseApproval(v.pendingApproval)
  if ((status === 'waiting_for_approval') !== (pendingApproval !== null) || (v.pendingApproval !== null && !pendingApproval)) return null
  return {
    id: v.id, agentId: v.agentId, title: v.title, description: v.description, status, createdAt: v.createdAt, startedAt: v.startedAt, completedAt: v.completedAt,
    resultSummary: v.resultSummary, errorMessage: v.errorMessage, executionId: v.executionId, timeoutMs: v.timeoutMs as number | null, runtime: v.runtime, workspaceId, sessionId: v.sessionId,
    endedReason: v.endedReason as TaskEndReason | null, pendingApproval,
  }
}

function parseActivity(v: unknown): AgentActivity | null {
  if (!isObject(v) || !isText(v.id) || !isText(v.agentId) || !isTextOrNull(v.taskId) || typeof v.message !== 'string' || !isTime(v.timestamp) || !isOneOf(v.source, MODES)) return null
  const base = { id: v.id, agentId: v.agentId, taskId: v.taskId, message: v.message, timestamp: v.timestamp, source: v.source as AgentActivity['source'] }
  // Task events always name their task; agent events may or may not.
  if (isOneOf(v.type, TASK_ACTIVITIES) && base.taskId === null) return null
  if (v.type === 'desk-assigned') return isText(v.deskId) ? { ...base, type: v.type, deskId: v.deskId } : null
  if (v.type === 'task-progress') return isOneOf(v.step, STEPS) ? { ...base, type: v.type, step: v.step as 'thinking' | 'working' } : null
  if (v.type === 'task-approval-requested') return isText(v.approvalId) ? { ...base, type: v.type, approvalId: v.approvalId } : null
  if (v.type === 'task-approval-decided') return isText(v.approvalId) && isOneOf(v.decision, DECISIONS) ? { ...base, type: v.type, approvalId: v.approvalId, decision: v.decision as 'approve' | 'deny' } : null
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

const V1_END: Record<string, TaskEndReason> = { completed: 'completed', failed: 'failed', cancelled: 'cancelled' }

/**
 * Milestone 3A (schema v1) → v2, before validation. v1's simulated "waiting" becomes waiting_for_approval with a legacy
 * approval (the reload recovery then fails that run), and every task gets the v2 fields. Anything else passes through.
 */
export function migrateWorkforceV1(raw: unknown): unknown {
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.activities)) return raw
  const tasks = raw.tasks.map((t) => {
    if (!isObject(t)) return t
    const waiting = t.status === 'waiting'
    return {
      ...t,
      status: waiting ? 'waiting_for_approval' : t.status,
      timeoutMs: null, runtime: 'mock', sessionId: null,
      endedReason: typeof t.status === 'string' ? V1_END[t.status] ?? null : null,
      pendingApproval: waiting ? { id: `legacy-${t.id}`, tool: 'unknown', summary: 'Waiting for input (from an earlier version)', requestedAt: t.startedAt ?? t.createdAt } : null,
    }
  })
  const activities = raw.activities.map((a) => (isObject(a) && a.type === 'task-waiting' ? { ...a, type: 'task-approval-requested', approvalId: `legacy-${a.taskId}` } : a))
  return { ...raw, schemaVersion: 2, tasks, activities }
}

function readStored(json: string): WorkforceState | null {
  try {
    return parseWorkforce(JSON.parse(json))
  } catch {
    return null
  }
}

function read(storage: KV, key: string): string | null {
  return storage.getItem(key)
}

function problemOf(json: string): WorkforceLoadProblem {
  try {
    const raw: unknown = JSON.parse(json)
    if (isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > WORKFORCE_SCHEMA_VERSION) return 'unsupported-version'
  } catch {
    // Not JSON at all: corrupt.
  }
  return 'corrupt'
}

/**
 * Seeds the demo only when nothing was ever saved (neither v2 nor v1). v1 data is migrated in memory and written as v2
 * on the first change; the v1 key is never touched. Unreadable v2 data is copied to the backup key once and the app
 * starts empty; unreadable v1 data is simply left where it is.
 */
export function loadWorkforce(storage: KV | null, now: string): WorkforceLoadResult {
  const empty = (problem: WorkforceLoadProblem, preserved: Preserved | null = null): WorkforceLoadResult => ({ state: emptyWorkforce(), seeded: false, migrated: false, problem, preserved })
  if (!storage) return empty('unavailable')
  let json: string | null
  let v1: string | null = null
  try {
    json = read(storage, WORKFORCE_STORAGE_KEY)
    if (json === null) v1 = read(storage, WORKFORCE_V1_KEY)
  } catch {
    return empty('unavailable')
  }

  if (json === null && v1 === null) return { state: createDemoWorkforce(now), seeded: true, migrated: false, problem: null, preserved: null }
  if (json === null) {
    let migrated: WorkforceState | null = null
    try {
      migrated = parseWorkforce(migrateWorkforceV1(JSON.parse(v1!)))
    } catch {
      migrated = null
    }
    return migrated ? { state: recoverInterruptedTasks(migrated, now), seeded: false, migrated: true, problem: null, preserved: null } : empty('corrupt', 'left-in-place')
  }

  const state = readStored(json)
  if (state) return { state: recoverInterruptedTasks(state, now), seeded: false, migrated: false, problem: null, preserved: null }
  let preserved: Preserved = 'backup-exists'
  try {
    const backup = storage.getItem(WORKFORCE_BACKUP_KEY)
    if (backup === null) {
      storage.setItem(WORKFORCE_BACKUP_KEY, json)
      preserved = 'backup-created'
    } else if (backup === json) {
      // This exact data is already the backup (an earlier load wrote it, e.g. StrictMode's first mount).
      preserved = 'backup-created'
    }
  } catch {
    // No backup could be written: the value stays under the main key, and saveWorkforce refuses to overwrite it without one.
    preserved = 'left-in-place'
  }
  return empty(problemOf(json), preserved)
}

export function saveWorkforce(storage: KV | null, s: WorkforceState): { ok: true } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: 'Browser storage is not available.' }
  const json = serializeWorkforce(s)
  if (!readStored(json)) return { ok: false, error: 'The workforce data failed validation and was not saved.' }
  try {
    const current = storage.getItem(WORKFORCE_STORAGE_KEY)
    // Saves run on every change, so an unreadable value must be backed up before it is overwritten; if that fails, nothing is written.
    if (current !== null && !readStored(current) && storage.getItem(WORKFORCE_BACKUP_KEY) === null) storage.setItem(WORKFORCE_BACKUP_KEY, current)
    storage.setItem(WORKFORCE_STORAGE_KEY, json)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Saving failed.' }
  }
}
