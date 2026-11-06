import { ACTIVITY_LIMIT, type Agent, type AgentActivity, type AgentStatus, type AgentTask, type ApprovalChoice, type WorkforceState } from './types'
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

/** What a person or the UI may know about a permission rule: no digest, no path of the server. */
export type PermissionRuleView = {
  id: string
  scope: 'global' | 'agent' | 'task' | 'once'
  effect: 'allow' | 'deny' | 'ask'
  tool: string
  agentId: string | null
  taskId: string | null
  pathPattern: string | null
  /** The workspace the rule is bound to; missing or null means every workspace. */
  workspaceId?: string | null
  /** The runtime of the task whose approval made the rule; missing or null means tasks of every runtime. */
  runtime?: 'mock' | 'claude' | null
  createdAt: string
  createdBy: 'default' | 'user' | 'system'
  expiresAt: string | null
  revokedAt: string | null
  usedAt: string | null
  endedAt: string | null
  reason: string | null
  state: 'active' | 'expired' | 'revoked' | 'used' | 'ended'
}

export type PermissionChangeKind = 'granted' | 'revoked' | 'used' | 'ended' | 'expired'

/** Sent when a permission rule changes. It shares the id sequence and replay of the other events but never changes the workforce state. */
export type PermissionChangedEvent = { id: string; type: 'permission.changed'; at: string; kind: PermissionChangeKind; rule: PermissionRuleView }

export type WorkforceEvent = ChangeEvent | ResetEvent | PermissionChangedEvent

export type StateResponse = { state: WorkforceState; lastEventId: string; loadProblem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null; saveError: string | null }

export type ErrorResponse = { error: string }

export type CreateAgentBody = AgentInput
export type PatchAgentBody = Partial<AgentInput>
export type DeskBody = { deskId: string | null }
export type CreateTaskBody = { title: string; description?: string; workspaceId?: string | null; runtime?: 'mock' | 'claude' }
export type WorkspacesResponse = { workspaces: { id: string }[] }

/** What the server read from one agent file. A file grants nothing: only name, description, model and instructions are read. */
export type AgentFileContent = { name: string; description: string; model: string | null; instructions: string; ignoredFields: string[]; descriptionCut: boolean; secretsMasked: boolean }
export type AgentImportField = 'description' | 'model' | 'instructions'
/** `file` is a real file name only when the file could be read; a refused name shows as a label such as "(file 3)". `digest` is empty when the file could not be read. */
export type AgentFilePreview = { file: string; digest: string } & (
  | { ok: true; agent: AgentFileContent; suggestedRole: string; existing: { agentId: string; changes: AgentImportField[] } | null }
  | { ok: false; error: string }
)
export type AgentFilesResponse = { folder: 'found' | 'missing' | 'refused'; cut: boolean; files: AgentFilePreview[] }
export type ImportAgentBody = { workspaceId: string; file: string; digest: string; role: string; department: AgentInput['department'] }
export type ReimportAgentBody = { digest: string }

/** Send on every POST, PUT, PATCH and DELETE, even without a body: the server refuses state changes without it (Stage C). */
export const MUTATION_HEADERS = { 'Content-Type': 'application/json' } as const
export type ApprovalBody = { approvalId: string; decision: ApprovalChoice; digest?: string }

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

/** Applies one change event's patch. state.reset returns the same state (the client reloads the snapshot instead), and so does permission.changed (permissions are not part of the workforce state). */
export function applyWorkforceEvent(s: WorkforceState, e: WorkforceEvent): WorkforceState {
  if (e.type === 'state.reset' || e.type === 'permission.changed') return s
  const { patch } = e
  const removed = new Set(patch.removedAgentIds)
  const agents = upsert(s.agents.filter((a) => !removed.has(a.id)), patch.agents)
  const tasks = upsert(s.tasks.filter((t) => !removed.has(t.agentId)), patch.tasks)
  const kept = s.activities.filter((a) => !removed.has(a.agentId))
  const activities = patch.activities.length > 0 ? [...kept, ...patch.activities].slice(-ACTIVITY_LIMIT) : kept
  return { ...s, agents, tasks, activities }
}

/** The part of GET /api/health the browser reads. */
export type RuntimeStatus = { kind: 'mock' | 'claude'; available: boolean; reason: string | null }
/** `runtimes` and `defaultRuntime` are absent from a server that predates per-task runtimes; `runtime`, `available` and `reason` describe the default one. */
export type HealthResponse = { ok: true; version: string; runtime: 'mock' | 'claude'; available: boolean; reason: string | null; runtimes?: RuntimeStatus[]; defaultRuntime?: 'mock' | 'claude'; credentialsConfigured: boolean; startedAt: string }
/** POST/PATCH agents and PUT desk answer with the agent. */
export type AgentResponse = { agent: Agent }

export type PermissionsResponse = { rules: PermissionRuleView[] }
export type PermissionResponse = { rule: PermissionRuleView }
export type AgentPermissionsRevokedResponse = { revoked: PermissionRuleView[] }
/** Only global and agent rules are created by hand; task and once rules come from approvals. */
export type CreatePermissionBody = { scope: 'global' | 'agent'; effect: 'allow' | 'deny' | 'ask'; tool: string; agentId?: string | null; pathPattern?: string | null; workspaceId?: string | null; expiresAt?: string | null; reason?: string | null }
