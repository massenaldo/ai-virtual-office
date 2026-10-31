import { createHash } from 'node:crypto'
import type { GatedOutcome, GatedAction, ToolGate, ToolGateResult, ToolRequest } from './runtime/types'
import { decideToolUse, toolDeniedMessage, type ToolPolicy } from './toolPolicy'
import type { ResolvedWorkspace } from './workspaces'

// The only way a runtime may use a tool. It never gets the policy, the workspace path or an approval id: it hands the
// gate a request and a `perform` function, and `perform` runs only after the policy and, for write, execute and network
// tools, a human have agreed to exactly that action, re-checked at the moment of use.

/** JSON with object keys sorted at every depth, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What an approval is bound to: this task, this workspace (id and real path), this tool and exactly this input. */
export function actionDigest(parts: { taskId: string; workspaceId: string | null; workspacePath: string | null; tool: string; input: unknown }): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex')
}

/** SHA-256 of the exact tool and input, with no workspace path in it: safe to write to the audit log and to compare with what a person saw. */
export function actionHash(tool: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool, input })).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

type WorkspaceNow = { ok: true; workspace: ResolvedWorkspace | null } | { ok: false }

export type ToolGateDeps = {
  taskId: string
  policy: ToolPolicy
  /** The task's workspace re-resolved right now; `{ ok: true, workspace: null }` for a task without one, `{ ok: false }` if it is gone or moved. */
  workspace(): WorkspaceNow
  /** Is the task still running (or waiting for this very approval)? */
  isLive(): boolean
  /** Policy decision, audit and, for `ask`, the human approval. Resolves once. */
  approve(request: ToolRequest, digest: string): Promise<ToolGateResult>
  /** Aborts when the task is cancelled, times out or ends. Handed to `perform`; checked once more just before it runs. */
  signal: AbortSignal
  /** Called when an approval is refused because the action changed since it was approved. */
  stale(tool: string, detail: string): void
  /**
   * The last check before `perform`: are the permission rules still willing? A once-grant is consumed here, so it can be
   * used once. A revoked, expired or already used permission refuses.
   */
  permit(request: ToolRequest, digest: string, paths: ReadonlyArray<{ readonly arg: string; readonly relative: string }>): { ok: true } | { ok: false }
}

const deny = (outcome: 'denied_by_policy' | 'stale_approval' | 'cancelled' | 'revoked', message: string): GatedOutcome<never> => ({ behavior: 'deny', outcome, message })

export function createToolGate(deps: ToolGateDeps): ToolGate {
  const digestFor = (tool: string, input: unknown, ws: WorkspaceNow): string | null =>
    ws.ok ? actionDigest({ taskId: deps.taskId, workspaceId: ws.workspace?.id ?? null, workspacePath: ws.workspace?.path ?? null, tool, input }) : null

  return {
    async use<T>(request: ToolRequest, perform: (action: GatedAction) => Promise<T> | T): Promise<GatedOutcome<T>> {
      let input: unknown
      try {
        input = deepFreeze(structuredClone(request.input))
      } catch {
        return deny('denied_by_policy', toolDeniedMessage(request.tool, 'invalid_input'))
      }
      const tool = request.tool
      const before = deps.workspace()
      // An unavailable workspace has no digest of its own; the use-time check below refuses the action if it is still unavailable.
      const digest = digestFor(tool, input, before) ?? actionDigest({ taskId: deps.taskId, workspaceId: null, workspacePath: null, tool, input })
      const answer = await deps.approve({ tool, input }, digest)
      if (answer.behavior === 'deny') return answer

      // Use time: everything the approval depended on is checked again, on the filesystem as it is now.
      if (!deps.isLive() || deps.signal.aborted) return deny('cancelled', 'The task is no longer running.')
      const now = deps.workspace()
      const refuse = (why: string): GatedOutcome<never> => {
        deps.stale(tool, `${why}; digest ${digest.slice(0, 12)}`)
        return deny('stale_approval', `Tool "${tool}" was not run: the action changed after it was approved (${why}).`)
      }
      if (!now.ok) return refuse('workspace unavailable')
      if (digestFor(tool, input, now) !== digest) return refuse('workspace changed')
      const recheck = decideToolUse(deps.policy, tool, input, now.workspace)
      if (recheck.decision === 'deny') return refuse(`path or policy check failed (${recheck.reason})`)

      const paths = recheck.paths ?? []
      if (!deps.permit({ tool, input }, digest, paths).ok) return deny('revoked', `The permission for tool "${tool}" was withdrawn or already used; it was not run.`)

      const value = await perform({ tool, input, workspace: now.workspace, signal: deps.signal, paths })
      return { behavior: 'allow', outcome: answer.outcome, value }
    },
  }
}
