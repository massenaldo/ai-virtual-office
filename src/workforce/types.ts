import type { BreakDepartment } from '../layout/catalog'
import type { DepartmentId } from '../layout/types'

export const WORKFORCE_SCHEMA_VERSION = 3

/** The most recent activity events kept in total; older ones are dropped. */
export const ACTIVITY_LIMIT = 300

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error'

export type TaskStatus = 'queued' | 'starting' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelling' | 'cancelled'

/** Which runtime a task runs on; separate from the agent's mode so a server can say what actually executed it. */
export type TaskRuntime = 'mock' | 'claude'

export type TaskEndReason = 'completed' | 'failed' | 'cancelled' | 'timeout'

export type ApprovalDecision = 'approve' | 'deny'
/** What a person may answer a backend approval with: the scope of an allow, or a rejection. The legacy approve and deny stay valid. */
export type ApprovalChoice = ApprovalDecision | 'allow_once' | 'allow_task' | 'allow_agent' | 'reject'

/** A runtime's request to use a tool that needs a human decision; set exactly while the task is waiting_for_approval. */
/** The most a review may show: UTF-8 bytes of the path and all text fields together. Above it nothing is asked. */
export const REVIEW_MAX_BYTES = 32768

/**
 * What a person reads before approving a Write or Edit: the exact content or change, never cut or reformatted.
 * `path` is relative to the workspace.
 */
export type ToolReviewBody = { path: string; bytes: number; lines: number } & ({ kind: 'write'; content: string } | { kind: 'edit'; oldString: string; newString: string; replaceAll: boolean })
/** The review as it sits on a pending approval: bound to the workspace and to the same action digest as the approval. */
export type ToolReview = ToolReviewBody & { workspaceId: string; digest: string }

/** digest: the server's SHA-256 of the exact action (task, workspace, tool, input) the approval is for; null for a simulated approval. */
export type PendingApproval = { id: string; tool: string; summary: string; requestedAt: string; digest: string | null; review: ToolReview | null; /** The server only accepts "allow once": a Write or Edit of a file that tools run on their own, or any write by the Claude agent unless ALLOW_BROAD_WRITE_SCOPES=yes. */ onceOnly: boolean }

export type RuntimeMode = 'mock' | 'real'

export type ActivitySource = 'mock' | 'real'

export type AgentDepartment = Exclude<DepartmentId, 'meeting' | BreakDepartment>

/** Bounds on an agent's free text, in characters. */
export const AGENT_DESCRIPTION_MAX = 500
export const AGENT_INSTRUCTIONS_MAX = 8192

/** deskId is a desk furniture ID and may point at a desk the layout no longer has. currentTaskId is the latest task, active or finished. */
export type Agent = { id: string; name: string; role: string; department: AgentDepartment; deskId: string | null; status: AgentStatus; currentTaskId: string | null; runtimeMode: RuntimeMode; demo: boolean; createdAt: string; lastActivityAt: string | null; description: string; instructions: string; /** null means the server's default model. */ model: string | null; takesPrayerBreaks: boolean; /** Set only by an import from a file; never settable through the API or form. */ sourceFile: string | null }

/** Steps and the runtime's own cost estimate for a finished task. Numbers only. */
export type TaskUsage = { turns: number; costUsd: number }
/** Above either bound a value is treated as corrupt, not as a real run. */
export const USAGE_MAX_TURNS = 1000
export const USAGE_MAX_COST_USD = 1000

/** The two numbers when both are within bounds (extra keys are dropped), otherwise null. */
export function validUsage(v: unknown): TaskUsage | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { turns, costUsd } = v as { turns?: unknown; costUsd?: unknown }
  if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 0 || turns > USAGE_MAX_TURNS) return null
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0 || costUsd > USAGE_MAX_COST_USD) return null
  return { turns, costUsd }
}

export type AgentTask = { id: string; agentId: string; title: string; description: string; status: TaskStatus; createdAt: string; startedAt: string | null; completedAt: string | null; resultSummary: string | null; errorMessage: string | null; executionId: string | null; timeoutMs: number | null; runtime: TaskRuntime; workspaceId: string | null; sessionId: string | null; endedReason: TaskEndReason | null; usage: TaskUsage | null; pendingApproval: PendingApproval | null }

type ActivityBase = { id: string; agentId: string; taskId: string | null; message: string; timestamp: string; source: ActivitySource }

export type AgentActivity = ActivityBase & (
  | { type: 'agent-created' }
  | { type: 'agent-updated' }
  | { type: 'desk-assigned'; deskId: string }
  | { type: 'desk-unassigned' }
  | { type: 'task-assigned' }
  | { type: 'task-started' }
  | { type: 'task-progress'; step: 'thinking' | 'working' }
  | { type: 'task-approval-requested'; approvalId: string }
  | { type: 'task-approval-decided'; approvalId: string; decision: ApprovalDecision }
  | { type: 'task-cancelling' }
  | { type: 'task-timed-out' }
  | { type: 'agent-message' }
  | { type: 'task-completed' }
  | { type: 'task-failed' }
  | { type: 'task-cancelled' }
)

export type ActivityType = AgentActivity['type']

export type WorkforceState = { schemaVersion: typeof WORKFORCE_SCHEMA_VERSION; agents: Agent[]; tasks: AgentTask[]; activities: AgentActivity[] }
