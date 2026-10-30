import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision } from '../../src/workforce/types'
import type { ExecutionResult, ExecutionStatus, ServerRuntimeProvider, StartContext, StartOutcome } from './types'

const REASON = 'Claude Agent SDK not installed'

/** Boundary for the Claude Agent SDK. It is not installed or integrated: this always reports unavailable and never runs anything. */
export class ClaudeAgentRuntimeProvider implements ServerRuntimeProvider {
  readonly kind = 'claude' as const
  readonly availability = { available: false, reason: REASON } as const

  start(_task: AgentTask, _ctx: StartContext): Promise<StartOutcome> {
    return Promise.resolve({ ok: false, error: REASON })
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
