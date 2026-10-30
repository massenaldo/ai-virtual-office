import type { Agent, AgentTask, ApprovalDecision } from '../types'
import type { RuntimeEvent, RuntimeProvider, StartResult } from './types'

/**
 * Placeholder for a future Claude Code / Claude Agent runtime. It runs nothing and always reports unavailable.
 *
 * Rule for the real implementation: execution happens on a server the app talks to, never in the browser.
 * The browser must never hold Anthropic credentials or API keys, and must never get shell access or the ability
 * to launch processes. The server owns the session, enforces what an agent may do, and streams RuntimeEvents
 * (started, progress, message, approval_requested, completed, failed, cancelled) back to the page, for example over server-sent
 * events. This class would then become a thin client for that stream and the server's start and cancel endpoints.
 */

export const CLAUDE_UNAVAILABLE = 'Not available: requires a server-side runtime.'

export class ClaudeRuntimeProvider implements RuntimeProvider {
  readonly mode = 'real' as const
  readonly availability = { available: false, reason: CLAUDE_UNAVAILABLE } as const

  start(_task: AgentTask, _agent: Agent): StartResult {
    return { ok: false, error: CLAUDE_UNAVAILABLE }
  }

  cancel(_taskId: string): void {}

  respondToApproval(_taskId: string, _approvalId: string, _decision: ApprovalDecision): void {}

  subscribe(_listener: (event: RuntimeEvent) => void): () => void {
    return () => {}
  }

  dispose(): void {}
}
