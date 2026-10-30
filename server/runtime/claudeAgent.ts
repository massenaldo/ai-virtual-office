import type { RuntimeAvailability, RuntimeEvent } from '../../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision } from '../../src/workforce/types'
import type { ExecutionResult, ExecutionStatus, ServerRuntimeProvider, StartContext, StartOutcome } from './types'

/**
 * Boundary for the Claude Agent SDK. It is NOT installed or integrated: this class always reports unavailable and never
 * runs anything. The rules below are what the real provider must follow when it lands. Verify the SDK's option names
 * against the installed version at that point; the names here describe the intent.
 *
 * 1. Availability. Check that the SDK is importable, then `credentialsConfigured`. ANTHROPIC_API_KEY is read only from the
 *    server environment and handed to the SDK only through its documented credential option or environment, never into
 *    prompts, events or logs.
 * 2. Workspace. `start` refuses a task with a null workspace (the manager already answers "The claude runtime needs a
 *    workspace."). The SDK's working directory is `ctx.workspace.path`, set by the server and never by the browser or the
 *    model. No additional directories are ever added.
 * 3. Permissions. Every tool call goes through the SDK's permission callback (`canUseTool`), which calls
 *    `ctx.requestToolApproval({ tool, input })`. An `allow` result maps to the SDK's allow result with the input unchanged;
 *    a `deny` maps to its deny result with `message`. Never pass an auto-approve tool list for write, execute or network
 *    tools, because SDK auto-approved tools skip the callback; pass every tool outside the catalogue as disallowed. The
 *    permission mode is `default`, never any other mode. Load no user, project or local settings files (no inherited
 *    allow rules), no MCP servers, and no hooks that could approve.
 * 4. Limits. Stream output only as RuntimeEvents, so the manager's caps, redaction, timeouts and approval timer apply.
 *    Never write files or logs directly.
 * 5. Termination. Pass an AbortController linked to `ctx.signal` to the SDK. On `cancel(taskId)`, abort and emit
 *    `cancelled` when the SDK confirms. The manager forces `cancelled` after CANCEL_GRACE_MS, and the provider must ignore
 *    events after its own abort.
 * 6. Process execution. This file becomes the single reviewed exception to server/noProcessExecution.test.ts, and only if
 *    the SDK needs to spawn its CLI. That needs a separate pull request that updates the guard's allowlist with a
 *    justification.
 * 7. Audit. Use `ctx.audit(note)` for session start and end and for abnormal termination. Never put prompts, inputs or
 *    outputs in notes.
 */

export const SDK_INSTALLED = false

/** The order of checks for the future provider: the SDK first, then credentials, then (until it exists) the integration itself. */
export function claudeUnavailableReason(sdkInstalled: boolean, credentialsConfigured: boolean): string {
  if (!sdkInstalled) return 'Claude Agent SDK not installed'
  if (!credentialsConfigured) return 'credentials not configured'
  return 'Claude Agent SDK integration is not implemented yet'
}

export class ClaudeAgentRuntimeProvider implements ServerRuntimeProvider {
  readonly kind = 'claude' as const
  readonly availability: RuntimeAvailability

  constructor(opts: { credentialsConfigured?: boolean } = {}) {
    this.availability = { available: false, reason: claudeUnavailableReason(SDK_INSTALLED, opts.credentialsConfigured ?? false) }
  }

  start(_task: AgentTask, _ctx: StartContext): Promise<StartOutcome> {
    return Promise.resolve({ ok: false, error: this.availability.available ? 'unavailable' : this.availability.reason })
  }

  cancel(_taskId: string): void {}

  status(_taskId: string): ExecutionStatus {
    return { state: 'unknown' }
  }

  result(_taskId: string): ExecutionResult | null {
    return null
  }

  respondToApproval(_taskId: string, _approvalId: string, _decision: ApprovalDecision): void {}

  subscribe(_listener: (event: RuntimeEvent) => void): () => void {
    return () => {}
  }

  async dispose(): Promise<void> {}
}
