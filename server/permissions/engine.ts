import { TOOL_CATALOGUE } from '../toolPolicy'
import { isValidPathPattern, matchesPathPattern } from './pathPattern'
import { REASON_MAX_CHARS, type GrantError, type GrantInput, type PermissionDecision, type PermissionQuery, type PermissionRule, type PermissionScope, type PermissionState } from './types'

// The pure part of the permission system: what a set of rules says about one request. It never reads a file or the clock
// (the caller passes `now`) and it fails closed: anything unexpected is a deny.

const HEX64 = /^[0-9a-f]{64}$/

export function ruleState(rule: PermissionRule, now: string): PermissionState {
  if (rule.revokedAt !== null) return 'revoked'
  if (rule.usedAt !== null) return 'used'
  if (rule.endedAt !== null) return 'ended'
  if (rule.expiresAt !== null) {
    const expires = Date.parse(rule.expiresAt)
    if (!Number.isFinite(expires) || Date.parse(now) >= expires) return 'expired'
  }
  return 'active'
}

/** The order in which scopes decide: the most specific first. */
const SCOPE_ORDER: readonly PermissionScope[] = ['once', 'task', 'agent', 'global']

function appliesTo(rule: PermissionRule, q: PermissionQuery): boolean {
  if (rule.tool !== q.tool) return false
  if (rule.agentId !== null && rule.agentId !== q.agentId) return false
  if (rule.taskId !== null && rule.taskId !== q.taskId) return false
  if (rule.scope === 'once' && rule.digest !== q.digest) return false
  return true
}

/**
 * Allow and ask rules with a pattern match only when the call names paths and every one fits (case-sensitive). A deny rule
 * matches when the call names no path at all (a workspace-wide search), or any path fits (case-insensitive, because
 * macOS file systems ignore case). The `/_` probe makes `secrets/**` cover the folder `secrets` itself.
 */
function pathsMatch(rule: PermissionRule, paths: readonly string[]): boolean {
  const pattern = rule.pathPattern
  if (pattern === null) return true
  if (rule.effect === 'deny') return paths.length === 0 || paths.some((p) => matchesPathPattern(pattern, p, false) || matchesPathPattern(pattern, `${p}/_`, false))
  return paths.length > 0 && paths.every((p) => matchesPathPattern(pattern, p, true))
}

export function evaluate(rules: readonly PermissionRule[], query: PermissionQuery, now: string): PermissionDecision {
  try {
    const matching = rules.filter((r) => ruleState(r, now) === 'active' && appliesTo(r, query) && pathsMatch(r, query.paths))
    const denied = matching.find((r) => r.effect === 'deny')
    if (denied) return { effect: 'deny', source: 'deny_rule', ruleId: denied.id }
    for (const scope of SCOPE_ORDER) {
      const inScope = matching.filter((r) => r.scope === scope)
      const decided = inScope.find((r) => r.effect === 'ask') ?? inScope[0]
      if (decided) return { effect: decided.effect, source: scope, ruleId: decided.id }
    }
    return { effect: 'deny', source: 'default', ruleId: null }
  } catch {
    return { effect: 'deny', source: 'error', ruleId: null }
  }
}

export type ValidGrant = Omit<PermissionRule, 'id' | 'createdAt' | 'revokedAt' | 'usedAt' | 'endedAt'>

export function validateGrant(input: GrantInput, now: string): { ok: true; fields: ValidGrant } | { ok: false; error: GrantError } {
  const fail = (error: GrantError) => ({ ok: false as const, error })
  const spec = TOOL_CATALOGUE.find((t) => t.name === input.tool)
  if (!spec) return fail('unknown_tool')
  const { scope, effect } = input
  if (!SCOPE_ORDER.includes(scope)) return fail('invalid_scope')
  if (effect !== 'allow' && effect !== 'deny' && effect !== 'ask') return fail('invalid_effect')
  const agentId = input.agentId ?? null
  const taskId = input.taskId ?? null
  if (scope === 'global' && (agentId !== null || taskId !== null)) return fail('invalid_scope')
  if (scope !== 'global' && agentId === null) return fail('missing_agent')
  if ((scope === 'task' || scope === 'once') && taskId === null) return fail('missing_task')
  if (scope === 'agent' && taskId !== null) return fail('invalid_scope')
  const digest = input.digest ?? null
  if (scope === 'once' && (digest === null || !HEX64.test(digest))) return fail('missing_digest')
  if (scope !== 'once' && digest !== null) return fail('invalid_scope')
  if (scope === 'once' && effect !== 'allow') return fail('invalid_effect')
  if (scope === 'task' && effect === 'ask') return fail('invalid_effect')
  if (effect === 'allow' && (spec.category === 'execute' || spec.category === 'network') && scope !== 'once') return fail('scope_not_allowed_for_tool')
  const pathPattern = input.pathPattern ?? null
  if (pathPattern !== null && (scope === 'once' || !isValidPathPattern(pathPattern))) return fail('invalid_pattern')
  const expiresAt = input.expiresAt ?? null
  if (expiresAt !== null) {
    const at = Date.parse(expiresAt)
    if (!Number.isFinite(at) || at <= Date.parse(now)) return fail('invalid_expiry')
  }
  const reason = input.reason ?? null
  if (reason !== null && reason.length > REASON_MAX_CHARS) return fail('invalid_reason')
  return { ok: true, fields: { scope, effect, tool: input.tool, agentId, taskId, pathPattern, digest, createdBy: input.createdBy ?? 'user', expiresAt, reason } }
}
