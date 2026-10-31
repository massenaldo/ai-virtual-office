import { ACTIVITY_LIMIT, type Agent, type AgentActivity, type AgentStatus, type AgentTask, type ApprovalDecision, type WorkforceState } from './types'
import type { AgentInput } from './operations'

// The wire contract between the backend and the browser: pure types and one pure function, with no I/O.

export type WorkforceEventType =
  | 'task.queued' | 'task.started' | 'agent.status_changed' | 'agent.message' | 'task.progress'
  | 'task.waiting_for_approval' | 'task.completed' | 'task.failed' | 'task.cancelled'
  | 'state.changed' | 'state.reset'

/** Every event name the stream can send, in the order of the union above. */
export const WORKFORCE_EVENT_TYPES = [
  'task.queued', 'task.started', 'agent.status_changed', 'agent.message', 'task.progress',
  'task.waiting_for_approval', 'task.completed', 'task.failed', 'task.cancelled',
  'state.changed', 'state.reset',
] as const satisfies readonly WorkforceEventType[]

/** The authoritative records an event carries: upsert agents and tasks by id, append activities (then keep the newest ACTIVITY_LIMIT), drop removed agents with their tasks and activities. */
export type WorkforcePatch = { agents: Agent[]; tasks: AgentTask[]; activities: AgentActivity[]; removedAgentIds: string[] }

/** from/to are set only on agent.status_changed. */
export type ChangeEvent = { id: string; type: Exclude<WorkforceEventType, 'state.reset'>; at: string; agentId: string | null; taskId: string | null; patch: WorkforcePatch; from?: AgentStatus; to?: AgentStatus }

/** Sent when a client's last event id can't be replayed; the client reloads the full state. */
export type ResetEvent = { id: string; type: 'state.reset'; at: string; reason: 'gap' }

export type WorkforceEvent = ChangeEvent | ResetEvent

export type StateResponse = { state: WorkforceState; lastEventId: string; loadProblem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null; saveError: string | null }

export type ErrorResponse = { error: string }

export type CreateAgentBody = AgentInput
export type PatchAgentBody = Partial<AgentInput>
export type DeskBody = { deskId: string | null }
export type CreateTaskBody = { title: string; description?: string; workspaceId?: string | null }
export type WorkspacesResponse = { workspaces: { id: string }[] }

/** Send on every POST, PUT, PATCH and DELETE, even without a body: the server refuses state changes without it (Stage C). */
export const MUTATION_HEADERS = { 'Content-Type': 'application/json' } as const
export type ApprovalBody = { approvalId: string; decision: ApprovalDecision }

/** Event ids are '<boot>:<seq>': seq rises within one server run, and the boot part tells a client its id predates a restart. */
export function parseEventId(id: string): { boot: string; seq: number } | null {
  const cut = id.lastIndexOf(':')
  if (cut <= 0) return null
  const seq = id.slice(cut + 1)
  return /^\d+$/.test(seq) ? { boot: id.slice(0, cut), seq: Number(seq) } : null
}

function upsert<T extends { id: string }>(items: T[], changed: T[]): T[] {
  if (changed.length === 0) return items
  const byId = new Map(changed.map((c) => [c.id, c]))
  const known = new Set(items.map((i) => i.id))
  return [...items.map((i) => byId.get(i.id) ?? i), ...changed.filter((c) => !known.has(c.id))]
}

/** Applies one change event's patch. state.reset returns the same state: the client reloads the snapshot instead. */
export function applyWorkforceEvent(s: WorkforceState, e: WorkforceEvent): WorkforceState {
  if (e.type === 'state.reset') return s
  const { patch } = e
  const removed = new Set(patch.removedAgentIds)
  const agents = upsert(s.agents.filter((a) => !removed.has(a.id)), patch.agents)
  const tasks = upsert(s.tasks.filter((t) => !removed.has(t.agentId)), patch.tasks)
  const kept = s.activities.filter((a) => !removed.has(a.agentId))
  const activities = patch.activities.length > 0 ? [...kept, ...patch.activities].slice(-ACTIVITY_LIMIT) : kept
  return { ...s, agents, tasks, activities }
}

/** The part of GET /api/health the browser reads. */
export type HealthResponse = { ok: true; version: string; runtime: 'mock' | 'claude'; available: boolean; reason: string | null; credentialsConfigured: boolean; startedAt: string }
/** POST/PATCH agents and PUT desk answer with the agent. */
export type AgentResponse = { agent: Agent }
