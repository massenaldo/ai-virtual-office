import { realpathSync } from 'node:fs'
import { activeTaskFor, applyRuntimeEvent, assignTask, cancelTask as forceCancel, decideApproval as recordDecision, isActiveTask, markStarting, removeAgent as dropAgent, requestCancel, timeOutTask, validateTaskInput, type TaskInput } from '../src/workforce/operations'
import { createId } from '../src/layout/operations'
import type { RuntimeEvent } from '../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision, TaskRuntime, WorkforceState } from '../src/workforce/types'
import type { ServerConfig } from './config'
import { messageTruncatedMarker, outputLimitMarker, truncateUtf8 } from './limits'
import type { Logger } from './log'
import { redactSecrets } from './redact'
import { sourceFor, type DemoProvider, type ServerRuntimeProvider, type ToolGateResult, type ToolRequest } from './runtime/types'
import type { WorkforceStore } from './store'
import { createToolGate } from './toolGate'
import { decideToolUse, sanitizeSummary, toolDeniedMessage, type DenyReason, type ToolPolicy } from './toolPolicy'
import { resolveWorkspace, WORKSPACE_ID_RE, type ResolvedWorkspace, type WorkspaceReason } from './workspaces'

export type ManagerError = { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'unavailable' | 'bad_request'; error: string }
export type ManagerResult<T = Record<never, never>> = ({ ok: true } & T) | ManagerError

export type LifecycleAction = 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout' | 'approval.requested' | 'approval.decided' | 'approval.timeout' | 'tool.allowed' | 'tool.denied' | 'tool.asked' | 'tool.stale' | 'workspace.rejected' | 'runtime.note'

export type LifecycleActor = 'api' | 'system' | 'runtime'

/** What the manager reports about itself: ids and reason codes only, never request bodies or paths. */
export type LifecycleEvent = { action: LifecycleAction; actor: LifecycleActor; taskId: string | null; agentId: string; requestId?: string; workspaceId?: string; tool?: string; decision?: string; reason?: string; detail?: string }

/** Passed by the HTTP layer: a request id marks the call as coming from the API rather than a timer. */
export type CallOptions = { requestId?: string }

const actorFor = (opts: CallOptions): LifecycleActor => (opts.requestId ? 'api' : 'system')

const WORKSPACE_COPY = (reason: WorkspaceReason, id: unknown): string => {
  switch (reason) {
    case 'not_configured': return 'Workspaces are not configured on this server.'
    case 'invalid_id': return '"workspaceId" must be a workspace id: 1–32 lowercase letters, digits or hyphens.'
    case 'unknown': return `Unknown workspace "${String(id)}".`
    default: return `Workspace "${String(id)}" is not available.`
  }
}

export type TaskManagerOptions = {
  store: WorkforceStore
  provider: ServerRuntimeProvider
  policy: ToolPolicy
  config: Pick<ServerConfig, 'taskTimeoutMs' | 'cancelGraceMs' | 'approvalTimeoutMs' | 'maxMessageBytes' | 'maxTaskOutputBytes' | 'workspaceRoot' | 'workspaces'>
  now: () => string
  log: Logger
  /** Audit seam: called for each lifecycle step the manager takes. */
  onLifecycle?: (e: LifecycleEvent) => void
}

export const APPROVAL_TIMEOUT_MESSAGE = (ms: number) => `No approval decision within ${Math.round(ms / 1000)} s`
export const unavailableMessage = (kind: TaskRuntime, reason: string) => `The ${kind} runtime is not available: ${reason}.`

type Timer = ReturnType<typeof setTimeout>

/** Everything the manager holds for one task while it is active; deleted when the task ends. */
type Run = { abort: AbortController; taskTimer: Timer | null; approvalTimer: Timer | null; approvalId: string | null; graceTimer: Timer | null; outputBytes: number; outputClosed: boolean; launched: boolean; workspace: ResolvedWorkspace | null; toolWaiter: { approvalId: string; tool: string; resolve: (r: ToolGateResult) => void } | null }

const CANCELLED: ToolGateResult = { behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }

const isDemo = (p: ServerRuntimeProvider): p is DemoProvider => 'requestApproval' in p && 'forceError' in p

/**
 * The lifecycle around a runtime provider: starting, duplicate-start refusal, task and approval timeouts, cancel with a
 * grace period, and output caps. Every change is read-op-commit on the store with state re-read after each await.
 */
export class TaskManager {
  private readonly store: WorkforceStore
  private readonly provider: ServerRuntimeProvider
  private readonly config: TaskManagerOptions['config']
  private readonly policy: ToolPolicy
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
    this.policy = opts.policy
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

  /** Builds the event without undefined keys, so a missing field is distinguishable from an empty one. */
  private report(action: LifecycleAction, task: AgentTask, x: { actor?: LifecycleActor; requestId?: string; tool?: string; decision?: string; reason?: string; detail?: string } = {}): void {
    const event: LifecycleEvent = { action, actor: x.actor ?? 'system', taskId: task.id, agentId: task.agentId }
    if (x.requestId !== undefined) event.requestId = x.requestId
    if (task.workspaceId !== null) event.workspaceId = task.workspaceId
    for (const key of ['tool', 'decision', 'reason', 'detail'] as const) if (x[key] !== undefined) event[key] = x[key]
    this.onLifecycle?.(event)
  }

  /** Synchronous: the task is `starting` when this returns, and the provider start continues in the background. */
  startTask(agentId: string, input: TaskInput, opts: CallOptions & { workspaceId?: string | null } = {}): ManagerResult<{ task: AgentTask }> {
    const availability = this.provider.availability
    if (!availability.available) return { ok: false, code: 'unavailable', error: unavailableMessage(this.provider.kind, availability.reason) }
    const agent = this.state.agents.find((a) => a.id === agentId)
    if (!agent) return { ok: false, code: 'not_found', error: 'Agent not found.' }
    const invalid = validateTaskInput(input)
    if (invalid) return { ok: false, code: 'invalid', error: invalid }

    let workspace: ResolvedWorkspace | null = null
    const requested = opts.workspaceId ?? null
    if (requested !== null) {
      const resolved = resolveWorkspace(this.config, requested)
      if (!resolved.ok) {
        const event: LifecycleEvent = { action: 'workspace.rejected', actor: actorFor(opts), taskId: null, agentId, reason: resolved.reason }
        if (opts.requestId !== undefined) event.requestId = opts.requestId
        // Only a well-formed id is safe to record; anything else could be attacker-chosen text.
        if (WORKSPACE_ID_RE.test(requested)) event.workspaceId = requested
        this.onLifecycle?.(event)
        return { ok: false, code: resolved.reason === 'invalid_id' ? 'bad_request' : 'invalid', error: WORKSPACE_COPY(resolved.reason, requested) }
      }
      workspace = resolved.workspace
    }
    if (this.provider.kind === 'claude' && workspace === null) return { ok: false, code: 'invalid', error: 'The claude runtime needs a workspace.' }
    if (activeTaskFor(this.state, agentId)) return { ok: false, code: 'conflict', error: `${agent.name} already has an active task.` }

    const assigned = assignTask(this.state, agentId, input, this.now(), { runtime: this.provider.kind, timeoutMs: this.config.taskTimeoutMs, workspaceId: workspace?.id ?? null })
    if (!assigned.ok) return { ok: false, code: 'invalid', error: assigned.error }
    this.store.commit(assigned.state)
    this.store.commit(markStarting(this.state, assigned.taskId, this.now()))

    const run: Run = { abort: new AbortController(), taskTimer: null, approvalTimer: null, approvalId: null, graceTimer: null, outputBytes: 0, outputClosed: false, launched: false, workspace, toolWaiter: null }
    this.runs.set(assigned.taskId, run)
    run.taskTimer = setTimeout(() => this.onTaskTimeout(assigned.taskId), this.config.taskTimeoutMs)
    const task = this.task(assigned.taskId)!
    this.report('task.start', task, { actor: actorFor(opts), requestId: opts.requestId })
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
      outcome = await this.provider.start(task, {
        agent,
        signal: run.abort.signal,
        workspace: run.workspace,
        tools: createToolGate({
          taskId,
          policy: this.policy,
          workspace: () => {
            if (run.workspace === null) return { ok: true, workspace: null }
            const r = resolveWorkspace(this.config, run.workspace.id)
            return r.ok ? { ok: true, workspace: r.workspace } : { ok: false }
          },
          isLive: () => { const t = this.task(taskId); return !!t && (t.status === 'running' || t.status === 'waiting_for_approval') },
          approve: (request) => this.approveTool(taskId, request),
          stale: (tool, detail) => { const t = this.task(taskId); if (t) this.report('tool.stale', t, { actor: 'runtime', tool, decision: 'deny', reason: 'stale_approval', detail }) },
        }),
        audit: (note) => { const t = this.task(taskId); if (t) this.report('runtime.note', t, { actor: 'runtime', detail: note }) },
      })
    } catch (error) {
      this.log.error(`Runtime failed to start task ${taskId}`, error)
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
    // A runtime still waiting on a tool answer must be released when its task ends, however it ends.
    this.settleTool(run, CANCELLED)
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
    this.settleTool(run, { behavior: 'deny', outcome: 'expired', message: APPROVAL_TIMEOUT_MESSAGE(this.config.approvalTimeoutMs) })
    this.finalize(taskId)
    this.report('approval.timeout', task)
  }

  cancelTask(taskId: string, opts: CallOptions = {}): ManagerResult<{ task: AgentTask }> {
    const task = this.task(taskId)
    if (!task) return { ok: false, code: 'not_found', error: 'Task not found.' }
    if (!isActiveTask(task)) return { ok: false, code: 'conflict', error: 'Task is not active.' }
    if (task.status === 'cancelling') return { ok: true, task }

    const run = this.runs.get(taskId)
    this.store.commit(requestCancel(this.state, taskId, this.now(), this.source))
    if (run?.taskTimer) clearTimeout(run.taskTimer)
    if (run) { run.taskTimer = null; this.settleTool(run, CANCELLED) }
    this.report('task.cancel', task, { actor: actorFor(opts), requestId: opts.requestId })

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

  decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision, opts: CallOptions = {}): ManagerResult<{ task: AgentTask }> {
    const task = this.task(taskId)
    if (!task) return { ok: false, code: 'not_found', error: 'Task not found.' }
    if (task.status !== 'waiting_for_approval' || !task.pendingApproval) return { ok: false, code: 'conflict', error: 'Task is not waiting for approval.' }
    if (task.pendingApproval.id !== approvalId) return { ok: false, code: 'conflict', error: 'That approval is no longer pending.' }
    this.store.commit(recordDecision(this.state, taskId, approvalId, decision, this.now(), this.source))
    const run = this.runs.get(taskId)
    if (run) this.clearApproval(run)
    this.report('approval.decided', task, { actor: actorFor(opts), requestId: opts.requestId, decision })
    if (run?.toolWaiter?.approvalId === approvalId) {
      // A tool request the manager is holding: answer the runtime's promise; the runtime decides what happens next.
      this.settleTool(run, decision === 'approve' ? { behavior: 'allow', outcome: 'approved' } : { behavior: 'deny', outcome: 'denied', message: 'Denied by a human reviewer.' })
    } else {
      // An approval the provider raised itself: its reaction arrives as events.
      this.provider.respondToApproval(taskId, approvalId, decision)
    }
    return { ok: true, task: this.task(taskId) ?? task }
  }

  removeAgent(agentId: string, opts: CallOptions = {}): ManagerResult<{ cancelledTaskId: string | null }> {
    if (!this.state.agents.some((a) => a.id === agentId)) return { ok: false, code: 'not_found', error: 'Agent not found.' }
    const activeTask = activeTaskFor(this.state, agentId)
    const { state, cancelledTaskId } = dropAgent(this.state, agentId)
    this.store.commit(state)
    if (cancelledTaskId) {
      if (activeTask) this.report('task.cancel', activeTask, { actor: actorFor(opts), requestId: opts.requestId, detail: 'agent removed' })
      const run = this.runs.get(cancelledTaskId)
      this.provider.cancel(cancelledTaskId)
      run?.abort.abort()
      this.finalize(cancelledTaskId)
    }
    return { ok: true, cancelledTaskId }
  }

  /** Resolves the runtime's pending tool request once; later calls do nothing. */
  private settleTool(run: Run, result: ToolGateResult): void {
    const waiter = run.toolWaiter
    if (!waiter) return
    run.toolWaiter = null
    waiter.resolve(result)
  }

  /**
   * The gate a runtime goes through before using a tool. The policy decides; an `ask` becomes the existing
   * waiting_for_approval state, approval timer and approval endpoint. Every state change happens before this returns.
   */
  private approveTool(taskId: string, request: ToolRequest): Promise<ToolGateResult> {
    const run = this.runs.get(taskId)
    const task = this.task(taskId)
    if (!run || !task || (task.status !== 'running' && task.status !== 'waiting_for_approval')) return Promise.resolve(CANCELLED)

    const d = decideToolUse(this.policy, request.tool, request.input, run.workspace)
    const tool = request.tool
    if (d.decision === 'allow') {
      this.report('tool.allowed', task, { actor: 'runtime', tool, decision: 'allow', reason: d.reason, detail: d.summary })
      return Promise.resolve({ behavior: 'allow', outcome: 'allowed' })
    }
    const refuse = (reason: DenyReason): Promise<ToolGateResult> => {
      this.report('tool.denied', task, { actor: 'runtime', tool, decision: 'deny', reason })
      return Promise.resolve({ behavior: 'deny', outcome: 'denied_by_policy', message: toolDeniedMessage(tool, reason) })
    }
    if (d.decision === 'deny') return refuse(d.reason)
    if (task.status === 'waiting_for_approval' || run.toolWaiter) return refuse('approval_pending')

    this.report('tool.asked', task, { actor: 'runtime', tool, decision: 'ask', reason: 'needs_approval', detail: d.summary })
    const approvalId = createId('approval')
    const promise = new Promise<ToolGateResult>((resolve) => { run.toolWaiter = { approvalId, tool, resolve } })
    this.onEvent({ type: 'approval_requested', taskId, approvalId, tool, summary: d.summary })
    this.report('approval.requested', task, { actor: 'runtime', tool, detail: `approvalId=${approvalId}` })
    return promise
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

  /** Server paths never reach state, events or responses: the workspace becomes <workspace>, the root <workspace-root>. */
  private hidePaths(run: Run, text: string): string {
    const roots = new Set<string>()
    const { workspaceRoot } = this.config
    if (workspaceRoot !== null) {
      roots.add(workspaceRoot)
      try { roots.add(realpathSync(workspaceRoot)) } catch { /* the root vanished: the configured spelling still gets replaced */ }
    }
    const pairs: Array<[string, string]> = [...(run.workspace ? [[run.workspace.path, '<workspace>'] as [string, string]] : []), ...[...roots].map((r): [string, string] => [r, '<workspace-root>'])]
    return pairs.sort((x, y) => y[0].length - x[0].length).reduce((t, [path, label]) => (path === '' ? t : t.split(path).join(label)), text)
  }

  /** Output caps, applied before an event reaches state. Progress text and errors are cut but never dropped; messages stop at the task budget. */
  private cap(run: Run, event: RuntimeEvent): RuntimeEvent | null {
    const { maxMessageBytes: perMessage, maxTaskOutputBytes: budget } = this.config
    // Cut first (redaction cost grows with length), then hide server paths and redact secrets.
    const clean = (text: string) => this.hidePaths(run, redactSecrets(text.length > perMessage + 4096 ? text.slice(0, perMessage + 4096) : text))
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
        const t = truncateUtf8(clean(event.text), perMessage)
        const used = Buffer.byteLength(t.text)
        if (run.outputBytes + used > budget) return { ...event, text: fit(t.text) }
        run.outputBytes += used
        return { ...event, text: t.truncated ? t.text + messageTruncatedMarker(perMessage) : t.text }
      }
      case 'progress': return { ...event, message: cut(clean(event.message)) }
      case 'failed': return { ...event, error: cut(clean(event.error)) }
      case 'approval_requested': return { ...event, summary: sanitizeSummary(event.summary) }
      case 'completed': {
        const t = truncateUtf8(clean(event.summary), perMessage)
        return { ...event, summary: fit(t.truncated ? t.text + messageTruncatedMarker(perMessage) : t.text) }
      }
      default: return event
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe()
    for (const run of this.runs.values()) {
      for (const timer of [run.taskTimer, run.approvalTimer, run.graceTimer]) if (timer) clearTimeout(timer)
      this.settleTool(run, CANCELLED)
      run.abort.abort()
    }
    this.runs.clear()
    await this.provider.dispose()
  }
}
