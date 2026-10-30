import type { Agent, AgentTask, ApprovalDecision, RuntimeMode } from '../types'

export type RuntimeEvent =
  | { type: 'started'; taskId: string; executionId: string; sessionId?: string }
  | { type: 'progress'; taskId: string; step: 'thinking' | 'working'; message: string }
  | { type: 'message'; taskId: string; text: string }
  | { type: 'approval_requested'; taskId: string; approvalId: string; tool: string; summary: string }
  | { type: 'completed'; taskId: string; summary: string }
  | { type: 'failed'; taskId: string; error: string }
  | { type: 'cancelled'; taskId: string }

export type StartResult = { ok: true; executionId: string } | { ok: false; error: string }

export type RuntimeAvailability = { available: true } | { available: false; reason: string }

/**
 * Execution boundary between the app and whatever runs a task. A provider only reports RuntimeEvents;
 * applyRuntimeEvent turns them into task, agent and activity changes. A real provider must run server-side.
 */
export interface RuntimeProvider {
  readonly mode: RuntimeMode
  readonly availability: RuntimeAvailability
  start(task: AgentTask, agent: Agent): StartResult
  cancel(taskId: string): void
  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void
  subscribe(listener: (event: RuntimeEvent) => void): () => void
  dispose(): void
}

/** Demo-only controls for showing the approval and error states on purpose. */
export interface MockDemoControls {
  requestApproval(taskId: string): void
  forceError(taskId: string, message?: string): void
}
