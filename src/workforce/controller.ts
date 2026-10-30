import { restoreDemoAgents } from './demo'
import * as ops from './operations'
import type { AgentInput, TaskInput } from './operations'
import { MockRuntimeProvider } from './runtime/mockRuntime'
import type { MockDemoControls, RuntimeProvider } from './runtime/types'
import { loadWorkforce, saveWorkforce, type Preserved } from './storage'
import type { ApprovalDecision, WorkforceState } from './types'

type KV = Pick<Storage, 'getItem' | 'setItem'>
type Runtime = RuntimeProvider & Partial<MockDemoControls>

export type WorkforceSnapshot = { state: WorkforceState; loadProblem: 'corrupt' | 'unsupported-version' | 'unavailable' | null; preserved: Preserved | null; saveError: string | null }
export type ActionResult = { ok: true } | { ok: false; error: string }

export type WorkforceController = {
  getSnapshot(): WorkforceSnapshot
  subscribe(listener: () => void): () => void
  createAgent(input: AgentInput): { ok: true; id: string } | { ok: false; error: string }
  updateAgent(id: string, patch: Partial<AgentInput>): ActionResult
  removeAgent(id: string): void
  assignDesk(agentId: string, deskId: string | null): ActionResult
  startTask(agentId: string, input: TaskInput): ActionResult
  cancelTask(taskId: string): void
  decideApproval(taskId: string, approvalId: string, decision: ApprovalDecision): void
  requestApproval(taskId: string): void
  forceError(taskId: string): void
  restoreDemoAgents(): void
  dismissLoadProblem(): void
  dispose(): void
}

/**
 * Owns the workforce state outside React. Every change, from a click or a runtime event, goes through commit() on
 * the current value, so neither can overwrite the other. Changes save automatically; loading never saves, so an
 * untouched demo seed or an unreadable stored value is only written once something actually changes.
 */
export function createWorkforceController(opts: { storage: KV | null; now?: () => string; runtime?: Runtime }): WorkforceController {
  const now = opts.now ?? (() => new Date().toISOString())
  const runtime = opts.runtime ?? new MockRuntimeProvider()
  const loaded = loadWorkforce(opts.storage, now())
  const listeners = new Set<() => void>()
  let current = loaded.state
  let snapshot: WorkforceSnapshot = { state: current, loadProblem: loaded.problem, preserved: loaded.preserved, saveError: null }
  let disposed = false

  const publish = (patch: Partial<WorkforceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((l) => l())
  }

  const commit = (next: WorkforceState) => {
    if (disposed || next === current) return
    current = next
    const saved = opts.storage ? saveWorkforce(opts.storage, next) : null
    publish({ state: next, saveError: saved && !saved.ok ? saved.error : null })
  }

  const unsubscribe = runtime.subscribe((event) => commit(ops.applyRuntimeEvent(current, event, now(), runtime.mode)))

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createAgent(input) {
      const r = ops.createAgent(current, input, now())
      if (!r.ok) return r
      commit(r.state)
      return { ok: true, id: r.id }
    },
    updateAgent(id, patch) {
      const r = ops.updateAgent(current, id, patch, now())
      if (!r.ok) return r
      commit(r.state)
      return { ok: true }
    },
    removeAgent(id) {
      const r = ops.removeAgent(current, id)
      commit(r.state)
      if (r.cancelledTaskId) runtime.cancel(r.cancelledTaskId)
    },
    assignDesk(agentId, deskId) {
      const r = ops.assignDesk(current, agentId, deskId, now())
      if (!r.ok) return r
      commit(r.state)
      return { ok: true }
    },
    startTask(agentId, input) {
      const r = ops.assignTask(current, agentId, input, now())
      if (!r.ok) return r
      commit(r.state)
      commit(ops.markStarting(current, r.taskId, now()))
      const task = current.tasks.find((t) => t.id === r.taskId)
      const agent = current.agents.find((a) => a.id === agentId)
      if (!task || !agent) return { ok: true }
      const started = runtime.start(task, agent)
      // A runtime that refuses (e.g. the Claude placeholder) must not leave the task queued forever.
      if (!started.ok) commit(ops.applyRuntimeEvent(current, { type: 'failed', taskId: task.id, error: started.error }, now(), runtime.mode))
      return { ok: true }
    },
    // cancelling → the runtime confirms with a cancelled event; a runtime that doesn't answer gets the task force-ended.
    cancelTask(taskId) {
      commit(ops.requestCancel(current, taskId, now(), runtime.mode))
      runtime.cancel(taskId)
      commit(ops.cancelTask(current, taskId, now()))
    },
    decideApproval(taskId, approvalId, decision) {
      const before = current
      commit(ops.decideApproval(current, taskId, approvalId, decision, now(), runtime.mode))
      if (current !== before) runtime.respondToApproval(taskId, approvalId, decision)
    },
    requestApproval: (taskId) => runtime.requestApproval?.(taskId),
    forceError: (taskId) => runtime.forceError?.(taskId),
    restoreDemoAgents: () => commit(restoreDemoAgents(current, now())),
    dismissLoadProblem: () => { if (snapshot.loadProblem) publish({ loadProblem: null }) },
    dispose() {
      disposed = true
      unsubscribe()
      runtime.dispose()
      listeners.clear()
    },
  }
}
