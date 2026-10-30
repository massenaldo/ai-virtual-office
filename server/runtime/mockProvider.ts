import { MOCK_TIMINGS, MockRuntimeProvider } from '../../src/workforce/runtime/mockRuntime'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision } from '../../src/workforce/types'
import type { DemoProvider, ExecutionResult, ExecutionStatus, StartContext, StartOutcome } from './types'

type Record = { executionId: string; pendingApprovalId: string | null; outcome: 'running' | 'completed' | 'failed' | 'cancelled'; summary: string; error: string }

const KEEP_ENDED = 200

/**
 * The browser's simulated runtime behind contract v2. It wraps MockRuntimeProvider unchanged, keeping a small record per
 * task so status() and result() can answer, and re-emits every event.
 */
export class ServerMockProvider implements DemoProvider {
  readonly kind = 'mock' as const
  readonly availability = { available: true } as const
  private readonly inner: MockRuntimeProvider
  private readonly records = new Map<string, Record>()
  private readonly ended: string[] = []
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  constructor(opts: { timings?: typeof MOCK_TIMINGS } = {}) {
    this.inner = new MockRuntimeProvider(opts)
    this.inner.subscribe((event) => this.onInner(event))
  }

  start(task: AgentTask, ctx: StartContext): Promise<StartOutcome> {
    const started = this.inner.start(task, ctx.agent)
    if (!started.ok) return Promise.resolve(started)
    this.records.set(task.id, { executionId: started.executionId, pendingApprovalId: null, outcome: 'running', summary: '', error: '' })
    return Promise.resolve({ ok: true, executionId: started.executionId, sessionId: null })
  }

  cancel(taskId: string): void {
    this.inner.cancel(taskId)
  }

  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void {
    this.inner.respondToApproval(taskId, approvalId, decision)
  }

  requestApproval(taskId: string): void {
    this.inner.requestApproval(taskId)
  }

  forceError(taskId: string, message?: string): void {
    this.inner.forceError(taskId, message)
  }

  status(taskId: string): ExecutionStatus {
    const r = this.records.get(taskId)
    if (!r) return { state: 'unknown' }
    if (r.outcome === 'running') return { state: 'running', executionId: r.executionId, sessionId: null, pendingApprovalId: r.pendingApprovalId }
    return { state: 'ended', executionId: r.executionId, outcome: r.outcome }
  }

  result(taskId: string): ExecutionResult | null {
    const r = this.records.get(taskId)
    if (!r || r.outcome === 'running') return null
    if (r.outcome === 'completed') return { outcome: 'completed', summary: r.summary }
    if (r.outcome === 'failed') return { outcome: 'failed', error: r.error }
    return { outcome: 'cancelled' }
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    this.listeners.clear()
    this.inner.dispose()
  }

  private onInner(event: RuntimeEvent): void {
    const r = this.records.get(event.taskId)
    if (r) {
      if (event.type === 'approval_requested') r.pendingApprovalId = event.approvalId
      else if (event.type === 'progress') r.pendingApprovalId = null
      else if (event.type === 'completed') this.end(event.taskId, r, 'completed', { summary: event.summary })
      else if (event.type === 'failed') this.end(event.taskId, r, 'failed', { error: event.error })
      else if (event.type === 'cancelled') this.end(event.taskId, r, 'cancelled', {})
    }
    for (const listener of this.listeners) listener(event)
  }

  private end(taskId: string, r: Record, outcome: 'completed' | 'failed' | 'cancelled', detail: { summary?: string; error?: string }): void {
    r.outcome = outcome
    r.pendingApprovalId = null
    r.summary = detail.summary ?? ''
    r.error = detail.error ?? ''
    this.ended.push(taskId)
    while (this.ended.length > KEEP_ENDED) this.records.delete(this.ended.shift()!)
  }
}
