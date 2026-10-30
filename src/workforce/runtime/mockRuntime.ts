import { createId } from '../../layout/operations'
import type { Agent, AgentTask, ApprovalDecision } from '../types'
import type { MockDemoControls, RuntimeEvent, RuntimeProvider, StartResult } from './types'

/**
 * Simulated runs driven by browser timers: thinking, then working, then completed. Nothing is executed and no AI
 * is called; every message says it is simulated. Events are always delivered from a timer or a control call,
 * never during start(), so callers can update state before the first event arrives.
 */

export const MOCK_TIMINGS = { thinkingMs: 2000, workingMs: 4000 }
export const MOCK_ERROR_MESSAGE = 'Simulated error (demo control).'
export const MOCK_DENIED_MESSAGE = 'Approval denied (simulated)'

// approvalId is set while the run waits for a decision on a simulated tool request.
type Run = { title: string; approvalId: string | null; started: boolean; timers: ReturnType<typeof setTimeout>[] }

export class MockRuntimeProvider implements RuntimeProvider, MockDemoControls {
  readonly mode = 'mock' as const
  readonly availability = { available: true } as const
  private readonly timings: typeof MOCK_TIMINGS
  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  constructor(opts: { timings?: typeof MOCK_TIMINGS } = {}) {
    this.timings = opts.timings ?? MOCK_TIMINGS
  }

  activeTaskIds(): string[] {
    return [...this.runs.keys()]
  }

  start(task: AgentTask, _agent: Agent): StartResult {
    if (this.runs.has(task.id)) return { ok: false, error: 'Task is already running.' }
    const executionId = createId('exec')
    this.runs.set(task.id, { title: task.title, approvalId: null, started: false, timers: [] })
    this.schedule(task.id, 0, () => {
      const run = this.runs.get(task.id)
      if (run) run.started = true
      this.emit({ type: 'started', taskId: task.id, executionId })
      this.emit({ type: 'progress', taskId: task.id, step: 'thinking', message: 'Thinking (simulated)' })
    })
    this.schedule(task.id, this.timings.thinkingMs, () => this.emit({ type: 'progress', taskId: task.id, step: 'working', message: 'Working (simulated)' }))
    this.scheduleCompletion(task.id, this.timings.thinkingMs + this.timings.workingMs)
    return { ok: true, executionId }
  }

  cancel(taskId: string): void {
    if (this.finish(taskId)) this.emit({ type: 'cancelled', taskId })
  }

  /** Demo control: pause a running task on a simulated request to write a file. */
  requestApproval(taskId: string): void {
    const run = this.runs.get(taskId)
    if (!run || !run.started || run.approvalId) return
    this.clearTimers(run)
    run.approvalId = createId('approval')
    this.emit({ type: 'approval_requested', taskId, approvalId: run.approvalId, tool: 'Write', summary: 'Simulated request to write a file' })
  }

  /** Approve carries on to completion; deny ends the simulated run as failed. Answers for another approval id change nothing. */
  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void {
    const run = this.runs.get(taskId)
    if (!run || run.approvalId === null || run.approvalId !== approvalId) return
    run.approvalId = null
    if (decision === 'deny') {
      if (this.finish(taskId)) this.emit({ type: 'failed', taskId, error: MOCK_DENIED_MESSAGE })
      return
    }
    this.emit({ type: 'progress', taskId, step: 'working', message: 'Working (simulated)' })
    this.scheduleCompletion(taskId, this.timings.workingMs)
  }

  forceError(taskId: string, message: string = MOCK_ERROR_MESSAGE): void {
    if (this.finish(taskId)) this.emit({ type: 'failed', taskId, error: message })
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Drops every run without events; tasks it was running stay active in state until cancelTask or a reload ends them. */
  dispose(): void {
    this.runs.forEach((run) => this.clearTimers(run))
    this.runs.clear()
    this.listeners.clear()
  }

  private scheduleCompletion(taskId: string, delay: number): void {
    this.schedule(taskId, delay, () => {
      const run = this.runs.get(taskId)
      if (run && this.finish(taskId)) this.emit({ type: 'completed', taskId, summary: `Simulated result for "${run.title}". No AI was run.` })
    })
  }

  private schedule(taskId: string, delay: number, fn: () => void): void {
    this.runs.get(taskId)?.timers.push(setTimeout(fn, delay))
  }

  /** Stops a run's timers and forgets it; false when the task isn't running here. */
  private finish(taskId: string): boolean {
    const run = this.runs.get(taskId)
    if (!run) return false
    this.clearTimers(run)
    this.runs.delete(taskId)
    return true
  }

  private clearTimers(run: Run): void {
    run.timers.forEach(clearTimeout)
    run.timers = []
  }

  private emit(event: RuntimeEvent): void {
    // One failing listener must not stop the others from hearing about the run.
    this.listeners.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error('Workforce runtime listener failed', error)
      }
    })
  }
}
