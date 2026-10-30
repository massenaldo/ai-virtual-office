import type { Agent, AgentTask, RuntimeMode } from '../types'

export type RuntimeEvent =
  | { type: 'started'; taskId: string; executionId: string }
  | { type: 'progress'; taskId: string; step: 'thinking' | 'working'; message: string }
  | { type: 'waiting'; taskId: string; message: string }
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
  subscribe(listener: (event: RuntimeEvent) => void): () => void
  dispose(): void
}

/** Demo-only controls for showing the waiting and error states on purpose. */
export interface MockDemoControls {
  forceWaiting(taskId: string): void
  resume(taskId: string): void
  forceError(taskId: string, message?: string): void
}
