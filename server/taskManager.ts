import { activeTaskFor, applyRuntimeEvent, assignTask, cancelTask as forceCancel, decideApproval as recordDecision, isActiveTask, markStarting, removeAgent as dropAgent, requestCancel, timeOutTask, validateTaskInput, type TaskInput } from '../src/workforce/operations'
import type { RuntimeEvent } from '../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision, TaskRuntime, WorkforceState } from '../src/workforce/types'
import type { ServerConfig } from './config'
import { messageTruncatedMarker, outputLimitMarker, truncateUtf8 } from './limits'
import type { Logger } from './log'
import { sourceFor, type DemoProvider, type ServerRuntimeProvider } from './runtime/types'
import type { WorkforceStore } from './store'

export type ManagerError = { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'unavailable'; error: string }
export type ManagerResult<T = Record<never, never>> = ({ ok: true } & T) | ManagerError

export type LifecycleAction = 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout' | 'approval.decided' | 'approval.timeout'

export type TaskManagerOptions = {
  store: WorkforceStore
  provider: ServerRuntimeProvider
  config: Pick<ServerConfig, 'taskTimeoutMs' | 'cancelGraceMs' | 'approvalTimeoutMs' | 'maxMessageBytes' | 'maxTaskOutputBytes'>
  now: () => string
  log: Logger
  /** Stage C audit seam: called for each lifecycle step the manager takes on its own. */
  onLifecycle?: (e: { action: LifecycleAction; taskId: string; agentId: string; detail?: string }) => void
}

export const APPROVAL_TIMEOUT_MESSAGE = (ms: number) => `No approval decision within ${Math.round(ms / 1000)} s`
export const unavailableMessage = (kind: TaskRuntime, reason: string) => `The ${kind} runtime is not available: ${reason}.`

type Timer = ReturnType<typeof setTimeout>

/** Everything the manager holds for one task while it is active; deleted when the task ends. */
type Run = { abort: AbortController; taskTimer: Timer | null; approvalTimer: Timer | null; approvalId: string | null; graceTimer: Timer | null; outputBytes: number; outputClosed: boolean; launched: boolean }

const isDemo = (p: ServerRuntimeProvider): p is DemoProvider => 'requestApproval' in p && 'forceError' in p

/**
 * The lifecycle around a runtime provider: starting, duplicate-start refusal, task and approval timeouts, cancel with a
 * grace period, and output caps. Every change is read-op-commit on the store with state re-read after each await.
 */
export class TaskManager {
  private readonly store: WorkforceStore
  private readonly provider: ServerRuntimeProvider
  private readonly config: TaskManagerOptions['config']
  private readonly now: () => string
  private readonly log: Logger
  private readonly onLifecycle: TaskManagerOptions['onLifecycle']
  private readonly runs = new Map<string, Run>()
  private readonly unsubscribe: () => void
  private readonly source

  constructor(opts: TaskManagerOptions) {
    this.store = opts.store
    this.provider = opts.provider
    this.config = opts.config
    this.now = opts.now
    this.log = opts.log
    this.onLifecycle = opts.onLifecycle
    this.source = sourceFor(opts.provider.kind)
    this.unsubscribe = opts.provider.subscribe((event) => this.onEvent(event))
  }

  private get state(): WorkforceState {
    return this.store.state
  }

  private task(id: string): AgentTask | undefined {
    return this.state.tasks.find((t) => t.id === id)
  }

  private report(action: LifecycleAction, task: AgentTask, detail?: string): void {
    this.onLifecycle?.({ action, taskId: task.id, agentId: task.agentId, detail })
  }

  /** Synchronous: the task is `starting` when this returns, and the provider start continues in the background. */
  startTask(agentId: string, input: TaskInput): ManagerResult<{ task: AgentTask }> {
    const availability = this.provider.availability
    if (!availability.available) return { ok: false, code: 'unavailable', error: unavailableMessage(this.provider.kind, availability.reason) }
    const agent = this.state.agents.find((a) => a.id === agentId)
    if (!agent) return { ok: false, code: 'not_found', error: 'Agent not found.' }
    const invalid = validateTaskInput(input)
    if (invalid) return { ok: false, code: 'invalid', error: invalid }
    if (activeTaskFor(this.state, agentId)) return { ok: false, code: 'conflict', error: `${agent.name} already has an active task.` }

    const assigned = assignTask(this.state, agentId, input, this.now(), { runtime: this.provider.kind, timeoutMs: this.config.taskTimeoutMs })
    if (!assigned.ok) return { ok: false, code: 'invalid', error: assigned.error }
    this.store.commit(assigned.state)
    this.store.commit(markStarting(this.state, assigned.taskId, this.now()))

    const run: Run = { abort: new AbortController(), taskTimer: null, approvalTimer: null, approvalId: null, graceTimer: null, outputBytes: 0, outputClosed: false, launched: false }
    this.runs.set(assigned.taskId, run)
    run.taskTimer = setTimeout(() => this.onTaskTimeout(assigned.taskId), this.config.taskTimeoutMs)
    const task = this.task(assigned.taskId)!
    this.report('task.start', task)
    void this.launch(assigned.taskId)
    return { ok: true, task }
  }

  /** The duplicate guard: a task launches only while `starting`, once, and only if the provider isn't already running it. */
  private async launch(taskId: string): Promise<void> {
    const run = this.runs.get(taskId)
    const task = this.task(taskId)
    const agent = task && this.state.agents.find((a) => a.id === task.agentId)
    if (!run || run.launched || !task || !agent || task.status !== 'starting' || this.provider.status(taskId).state === 'running') return
    run.launched = true
    let outcome
    try {
      outcome = await this.provider.start(task, { agent, signal: run.abort.signal })
    } catch (error) {
      outcome = { ok: false as const, error: `Runtime failed to start: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!outcome.ok) {
      this.onEvent({ type: 'failed', taskId, error: outcome.error })
      return
    }
    // The task was cancelled, timed out or removed while the runtime was still starting: stop what just began.
    const now = this.task(taskId)
    if (!now || (now.status !== 'starting' && now.status !== 'running' && now.status !== 'waiting_for_approval')) this.provider.cancel(taskId)
  }

  private onEvent(event: RuntimeEvent): void {
    const run = this.runs.get(event.taskId)
    if (!run) return
    const capped = this.cap(run, event)
    if (!capped) return
    const before = this.state
    const next = applyRuntimeEvent(before, capped, this.now(), this.source)
    if (next === before) return
    this.store.commit(next)
    this.afterChange(event.taskId, run)
  }

  /** Keeps the manager's timers in step with the task: arm the approval timer on entering approval, clear it on leaving, finalize at the end. */
  private afterChange(taskId: string, run: Run): void {
    const task = this.task(taskId)
    if (!task || !isActiveTask(task)) return this.finalize(taskId)
    if (task.status === 'waiting_for_approval' && task.pendingApproval) {
      if (run.approvalId !== task.pendingApproval.id) this.armApprovalTimer(taskId, run, task.pendingApproval.id)
    } else this.clearApproval(run)
  }

  private armApprovalTimer(taskId: string, run: Run, approvalId: string): void {
    this.clearApproval(run)
    run.approvalId = approvalId
    run.approvalTimer = setTimeout(() => this.onApprovalTimeout(taskId, approvalId), this.config.approvalTimeoutMs)
  }

  private clearApproval(run: Run): void {
    if (run.approvalTimer) clearTimeout(run.approvalTimer)
    run.approvalTimer = null
    run.approvalId = null
  }

  private finalize(taskId: string): void {
    const run = this.runs.get(taskId)
    if (!run) return
    for (const timer of [run.taskTimer, run.approvalTimer, run.graceTimer]) if (timer) clearTimeout(timer)
    this.runs.delete(taskId)
  }

  private onTaskTimeout(taskId: string): void {
    const run = this.runs.get(taskId)
    const task = this.task(taskId)
    if (!run || !task || !isActiveTask(task)) return
    run.taskTimer = null
    this.store.commit(timeOutTask(this.state, taskId, this.now(), this.source))
    this.provider.cancel(taskId)
    run.abort.abort()
    this.finalize(taskId)
    this.report('task.timeout', task)
  }

  private onApprovalTimeout(taskId: string, approvalId: string): void {
    const run = this.runs.get(taskId)
    const task = this.task(taskId)
    if (!run || !task || task.status !== 'waiting_for_approval' || task.pendingApproval?.id !== approvalId) return
    run.approvalTimer = null
    this.store.commit(applyRuntimeEvent(this.state, { type: 'failed', taskId, error: APPROVAL_TIMEOUT_MESSAGE(this.config.approvalTimeoutMs) }, this.now(), this.source))
    this.provider.cancel(taskId)
    run.abort.abort()
    this.finalize(taskId)
    this.report('approval.timeout', task)
  }

  cancelTask(taskId: string): ManagerResult<{ task: AgentTask }> {
    const task = this.task(taskId)
    if (!task) return { ok: false, code: 'not_found', error: 'Task not found.' }
    if (!isActiveTask(task)) return { ok: false, code: 'conflict', error: 'Task is not active.' }
    if (task.status === 'cancelling') return { ok: true, task }

    const run = this.runs.get(taskId)
    this.store.commit(requestCancel(this.state, taskId, this.now(), this.source))
    if (run?.taskTimer) clearTimeout(run.taskTimer)
    if (run) run.taskTimer = null
    this.report('task.cancel', task)

    if (this.task(taskId)?.status === 'cancelled') {
      this.finalize(taskId)
      return { ok: true, task: this.task(taskId)! }
    }
    // The runtime confirms with a cancelled event (the mock does so at once, so the task may already be cancelled below).
    this.provider.cancel(taskId)
    const after = this.task(taskId)
    if (after && after.status === 'cancelling') {
      if (run) run.graceTimer = setTimeout(() => this.forceCancel(taskId), this.config.cancelGraceMs)
      else this.store.commit(forceCancel(this.state, taskId, this.now()))
    }
    return { ok: true, task: this.task(taskId) ?? task }
  }

  /** The runtime didn't confirm in time: end the task anyway and stop whatever it was doing. */
  private forceCancel(taskId: string): void {
    const run = this.runs.get(taskId)
    const task = this.task(taskId)
    if (!run || !task || task.status !== 'cancelling') return
    run.graceTimer = null
    this.store.commit(forceCancel(this.state, taskId, this.now()))
    run.abort.abort()
    this.finalize(taskId)
    this.log.warn(`Runtime did not confirm cancel of ${taskId} within ${this.config.cancelGraceMs} ms; marked cancelled.`)
    this.report('task.force_cancelled', task)
  }

  decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): ManagerResult<{ task: AgentTask }> {
    const task = this.task(taskId)
    if (!task) return { ok: false, code: 'not_found', error: 'Task not found.' }
    if (task.status !== 'waiting_for_approval' || !task.pendingApproval) return { ok: false, code: 'conflict', error: 'Task is not waiting for approval.' }
    if (task.pendingApproval.id !== approvalId) return { ok: false, code: 'conflict', error: 'That approval is no longer pending.' }
    this.store.commit(recordDecision(this.state, taskId, approvalId, decision, this.now(), this.source))
    const run = this.runs.get(taskId)
    if (run) this.clearApproval(run)
    this.report('approval.decided', task, decision)
    // The provider's reaction (the mock answers at once) arrives as events and is applied before this returns.
    this.provider.respondToApproval(taskId, approvalId, decision)
    return { ok: true, task: this.task(taskId) ?? task }
  }

  removeAgent(agentId: string): ManagerResult<{ cancelledTaskId: string | null }> {
    if (!this.state.agents.some((a) => a.id === agentId)) return { ok: false, code: 'not_found', error: 'Agent not found.' }
    const { state, cancelledTaskId } = dropAgent(this.state, agentId)
    this.store.commit(state)
    if (cancelledTaskId) {
      const run = this.runs.get(cancelledTaskId)
      this.provider.cancel(cancelledTaskId)
      run?.abort.abort()
      this.finalize(cancelledTaskId)
    }
    return { ok: true, cancelledTaskId }
  }

  private demo(taskId: string): ManagerResult<{ task: AgentTask; provider: DemoProvider }> {
    const task = this.task(taskId)
    if (!task) return { ok: false, code: 'not_found', error: 'Task not found.' }
    if (task.status !== 'running') return { ok: false, code: 'conflict', error: 'Task is not running.' }
    if (!isDemo(this.provider)) return { ok: false, code: 'unavailable', error: 'Demo controls need RUNTIME=mock.' }
    return { ok: true, task, provider: this.provider }
  }

  requestApproval(taskId: string): ManagerResult {
    const r = this.demo(taskId)
    if (!r.ok) return r
    r.provider.requestApproval(taskId)
    return { ok: true }
  }

  forceError(taskId: string): ManagerResult {
    const r = this.demo(taskId)
    if (!r.ok) return r
    r.provider.forceError(taskId)
    return { ok: true }
  }

  /** Output caps, applied before an event reaches state. Progress text and errors are cut but never dropped; messages stop at the task budget. */
  private cap(run: Run, event: RuntimeEvent): RuntimeEvent | null {
    const { maxMessageBytes: perMessage, maxTaskOutputBytes: budget } = this.config
    const cut = (text: string) => {
      const r = truncateUtf8(text, perMessage)
      return r.truncated ? r.text + messageTruncatedMarker(perMessage) : r.text
    }
    // The part of `text` that fits the task budget; once it runs out, a marker says later output is dropped.
    const fit = (text: string) => {
      const room = budget - run.outputBytes
      if (Buffer.byteLength(text) <= room) { run.outputBytes += Buffer.byteLength(text); return text }
      run.outputBytes = budget
      run.outputClosed = true
      return truncateUtf8(text, Math.max(room, 0)).text + outputLimitMarker(budget)
    }
    switch (event.type) {
      case 'message': {
        if (run.outputClosed) return null
        const t = truncateUtf8(event.text, perMessage)
        const used = Buffer.byteLength(t.text)
        if (run.outputBytes + used > budget) return { ...event, text: fit(t.text) }
        run.outputBytes += used
        return { ...event, text: t.truncated ? t.text + messageTruncatedMarker(perMessage) : t.text }
      }
      case 'progress': return { ...event, message: cut(event.message) }
      case 'failed': return { ...event, error: cut(event.error) }
      case 'completed': {
        const t = truncateUtf8(event.summary, perMessage)
        return { ...event, summary: fit(t.truncated ? t.text + messageTruncatedMarker(perMessage) : t.text) }
      }
      default: return event
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    for (const run of this.runs.values()) {
      for (const timer of [run.taskTimer, run.approvalTimer, run.graceTimer]) if (timer) clearTimeout(timer)
      run.abort.abort()
    }
    this.runs.clear()
    await this.provider.dispose()
  }
}
