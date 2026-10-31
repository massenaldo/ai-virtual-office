import type { MockDemoControls, RuntimeAvailability, RuntimeEvent } from '../../src/workforce/runtime/types'
import type { ActivitySource, Agent, AgentTask, ApprovalDecision, TaskRuntime } from '../../src/workforce/types'
import type { ResolvedWorkspace } from '../workspaces'

// Runtime contract v2, server side. It reuses the browser's RuntimeEvent so one event stream feeds applyRuntimeEvent.

/** A runtime's request to use a tool. The input is checked by the server against the policy, never trusted. */
export type ToolRequest = { tool: string; input: unknown }

export type ToolGateResult =
  | { behavior: 'allow'; outcome: 'allowed' | 'approved' }
  | { behavior: 'deny'; outcome: 'denied_by_policy' | 'denied' | 'expired' | 'cancelled'; message: string }

/** What `perform` receives: a deep-frozen copy of the request's input and the workspace as it was checked just before. */
export type GatedAction = { readonly tool: string; readonly input: unknown; readonly workspace: ResolvedWorkspace | null }

/** `stale_approval`: the action changed (a path now resolves elsewhere, the workspace moved) between approval and use. */
export type GatedOutcome<T> =
  | { behavior: 'allow'; outcome: 'allowed' | 'approved'; value: T }
  | { behavior: 'deny'; outcome: 'denied_by_policy' | 'denied' | 'expired' | 'cancelled' | 'stale_approval'; message: string }

/**
 * The only way a runtime may use a tool. `perform` runs only after the server's policy and, for write, execute and
 * network tools, a human approved exactly this action, re-checked immediately before it runs. The runtime never sees the
 * policy, the workspace path or an approval id, so it cannot use a tool any other way through this contract.
 */
export interface ToolGate {
  use<T>(request: ToolRequest, perform: (action: GatedAction) => Promise<T> | T): Promise<GatedOutcome<T>>
}

/** What a runtime needs to run one task. */
export type StartContext = {
  agent: Agent
  signal: AbortSignal
  /** The resolved workspace; path is a real path and stays on the server. null when the task has none. */
  workspace: ResolvedWorkspace | null
  /** The only way to use a tool. Bound to this task. */
  tools: ToolGate
  /** Writes a runtime.note audit record for this task (scrubbed and truncated). */
  audit: (note: string) => void
}

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
