import type { DepartmentId } from '../layout/types'

export const WORKFORCE_SCHEMA_VERSION = 1

/** The most recent activity events kept in total; older ones are dropped. */
export const ACTIVITY_LIMIT = 300

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error' | 'completed'

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export type RuntimeMode = 'mock' | 'real'

export type ActivitySource = 'mock' | 'real'

export type AgentDepartment = Exclude<DepartmentId, 'meeting'>

/** deskId is a desk furniture ID and may point at a desk the layout no longer has. currentTaskId is the latest task, active or finished. */
export type Agent = { id: string; name: string; role: string; department: AgentDepartment; deskId: string | null; status: AgentStatus; currentTaskId: string | null; runtimeMode: RuntimeMode; demo: boolean; createdAt: string; lastActivityAt: string | null }

export type AgentTask = { id: string; agentId: string; title: string; description: string; status: TaskStatus; createdAt: string; startedAt: string | null; completedAt: string | null; resultSummary: string | null; errorMessage: string | null; executionId: string | null }

type ActivityBase = { id: string; agentId: string; taskId: string | null; message: string; timestamp: string; source: ActivitySource }

export type AgentActivity = ActivityBase & (
  | { type: 'agent-created' }
  | { type: 'agent-updated' }
  | { type: 'desk-assigned'; deskId: string }
  | { type: 'desk-unassigned' }
  | { type: 'task-assigned' }
  | { type: 'task-started' }
  | { type: 'task-progress'; step: 'thinking' | 'working' }
  | { type: 'task-waiting' }
  | { type: 'task-completed' }
  | { type: 'task-failed' }
  | { type: 'task-cancelled' }
)

export type ActivityType = AgentActivity['type']

export type WorkforceState = { schemaVersion: typeof WORKFORCE_SCHEMA_VERSION; agents: Agent[]; tasks: AgentTask[]; activities: AgentActivity[] }
