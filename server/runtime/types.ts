import type { MockDemoControls, RuntimeAvailability, RuntimeEvent } from '../../src/workforce/runtime/types'
import type { ActivitySource, Agent, AgentTask, ApprovalDecision, TaskRuntime } from '../../src/workforce/types'
import type { ResolvedWorkspace } from '../workspaces'

// Runtime contract v2, server side. It reuses the browser's RuntimeEvent so one event stream feeds applyRuntimeEvent.

/** What a runtime needs to run one task. workspace.path is a real path and stays on the server. */
export type StartContext = { agent: Agent; signal: AbortSignal; workspace: ResolvedWorkspace | null }

export type StartOutcome = { ok: true; executionId: string; sessionId: string | null } | { ok: false; error: string }

export type ExecutionStatus =
  | { state: 'unknown' }
  | { state: 'running'; executionId: string; sessionId: string | null; pendingApprovalId: string | null }
  | { state: 'ended'; executionId: string; outcome: 'completed' | 'failed' | 'cancelled' }

export type ExecutionResult = { outcome: 'completed'; summary: string } | { outcome: 'failed'; error: string } | { outcome: 'cancelled' }

/**
 * What the task manager needs from whatever executes tasks. start is async, as a real SDK session start will be. The
 * task's executionId and sessionId reach state only through the `started` event; StartOutcome feeds logs and the run record.
 */
export interface ServerRuntimeProvider {
  readonly kind: TaskRuntime
  readonly availability: RuntimeAvailability
  start(task: AgentTask, ctx: StartContext): Promise<StartOutcome>
  cancel(taskId: string): void
  status(taskId: string): ExecutionStatus
  /** null until the execution has ended. */
  result(taskId: string): ExecutionResult | null
  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void
  subscribe(listener: (event: RuntimeEvent) => void): () => void
  dispose(): Promise<void>
}

export type DemoProvider = ServerRuntimeProvider & MockDemoControls

export const sourceFor = (kind: TaskRuntime): ActivitySource => (kind === 'claude' ? 'real' : 'mock')
