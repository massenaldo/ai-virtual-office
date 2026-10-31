// Shared types for the permission engine. No logic lives here.

export type PermissionScope = 'global' | 'agent' | 'task' | 'once'
export type PermissionEffect = 'allow' | 'deny' | 'ask'
export type PermissionState = 'active' | 'expired' | 'revoked' | 'used' | 'ended'

export type PermissionRule = {
  id: string
  scope: PermissionScope
  effect: PermissionEffect
  tool: string
  agentId: string | null
  taskId: string | null
  /** Workspace-relative glob that narrows the rule; never widens it. */
  pathPattern: string | null
  /** Once rules only: the exact action digest the grant is bound to. */
  digest: string | null
  createdAt: string
  createdBy: 'default' | 'user' | 'system'
  expiresAt: string | null
  revokedAt: string | null
  usedAt: string | null
  /** Set when the rule's task ended (task and once rules). */
  endedAt: string | null
  reason: string | null
}

export type GrantInput = {
  scope: PermissionScope
  effect: PermissionEffect
  tool: string
  agentId?: string | null
  taskId?: string | null
  pathPattern?: string | null
  digest?: string | null
  expiresAt?: string | null
  reason?: string | null
  createdBy?: 'user' | 'system'
}

/** `paths` are workspace-relative, as `CheckedPath.relative`. */
export type PermissionQuery = { agentId: string; taskId: string; tool: string; digest: string; paths: readonly string[] }

export type PermissionDecision = {
  effect: PermissionEffect
  source: 'deny_rule' | 'once' | 'task' | 'agent' | 'global' | 'default' | 'error'
  ruleId: string | null
}

export type GrantError = 'unknown_tool' | 'invalid_scope' | 'invalid_effect' | 'missing_agent' | 'missing_task' | 'missing_digest' | 'scope_not_allowed_for_tool' | 'invalid_pattern' | 'invalid_expiry' | 'invalid_reason'

export const PATTERN_MAX_CHARS = 200
export const REASON_MAX_CHARS = 200
