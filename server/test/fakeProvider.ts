import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision, TaskRuntime } from '../../src/workforce/types'
import type { ExecutionResult, ExecutionStatus, ServerRuntimeProvider, StartContext, StartOutcome } from '../runtime/types'

/** A scriptable provider for task manager tests: records calls, emits events on demand, and can hold start() open. */
export class FakeProvider implements ServerRuntimeProvider {
  readonly kind: TaskRuntime
  readonly availability = { available: true } as const
  starts: Array<{ task: AgentTask; ctx: StartContext }> = []
  cancels: string[] = []
  responses: Array<{ taskId: string; approvalId: string; decision: ApprovalDecision }> = []
  /** When true, cancel() answers with a cancelled event at once; otherwise it never confirms. */
  confirmCancel = false
  /** When true, start() stays pending until resolveStart or rejectStart. */
  defer = false
  lastSignal: AbortSignal | null = null
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()
  private readonly pending: Array<{ resolve: (o: StartOutcome) => void; reject: (e: unknown) => void }> = []
  private readonly running = new Set<string>()

  constructor(opts: { kind?: TaskRuntime } = {}) {
    this.kind = opts.kind ?? 'mock'
  }

  start(task: AgentTask, ctx: StartContext): Promise<StartOutcome> {
    this.starts.push({ task, ctx })
    this.lastSignal = ctx.signal
    this.running.add(task.id)
    if (!this.defer) return Promise.resolve({ ok: true, executionId: 'exec-fake', sessionId: null })
    return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }) })
  }

  resolveStart(outcome: StartOutcome): void {
    this.pending.shift()?.resolve(outcome)
  }

  rejectStart(error: unknown): void {
    this.pending.shift()?.reject(error)
  }

  cancel(taskId: string): void {
    this.cancels.push(taskId)
    if (this.confirmCancel) {
      this.running.delete(taskId)
      this.emit({ type: 'cancelled', taskId })
    }
  }

  status(taskId: string): ExecutionStatus {
    return this.running.has(taskId) ? { state: 'running', executionId: 'exec-fake', sessionId: null, pendingApprovalId: null } : { state: 'unknown' }
  }

  result(_taskId: string): ExecutionResult | null {
    return null
  }

  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void {
    this.responses.push({ taskId, approvalId, decision })
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
  }
}
