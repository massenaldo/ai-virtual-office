import type { PermissionChangedEvent, PermissionRuleView } from './api'

/** How many ended rules the History list keeps; the server also sends at most this many. */
export const HISTORY_LIMIT = 200

/** The browser's copy of the permission rules. `active` is oldest first, `history` newest first. `loaded` turns true after the first complete load. */
export type PermissionsState = { active: PermissionRuleView[]; history: PermissionRuleView[]; loaded: boolean; error: string | null }

export const emptyPermissions = (): PermissionsState => ({ active: [], history: [], loaded: false, error: null })

export const withLists = (s: PermissionsState, active: PermissionRuleView[], history: PermissionRuleView[]): PermissionsState => ({ ...s, active, history: history.slice(0, HISTORY_LIMIT), loaded: true, error: null })

const SCOPES = ['global', 'agent', 'task', 'once']
const EFFECTS = ['allow', 'deny', 'ask']
const STATES = ['active', 'expired', 'revoked', 'used', 'ended']
const text = (v: unknown): v is string => typeof v === 'string'
const textOrNull = (v: unknown): boolean => v === null || typeof v === 'string'

function isRule(v: unknown): v is PermissionRuleView {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return text(r.id) && SCOPES.includes(r.scope as string) && EFFECTS.includes(r.effect as string) && text(r.tool) && text(r.createdAt) && STATES.includes(r.state as string)
    && ['agentId', 'taskId', 'pathPattern', 'expiresAt', 'revokedAt', 'usedAt', 'endedAt', 'reason'].every((k) => textOrNull(r[k]))
    && (r.workspaceId === undefined || textOrNull(r.workspaceId))
    && (r.runtime === undefined || r.runtime === null || r.runtime === 'mock' || r.runtime === 'claude')
    && ['default', 'user', 'system'].includes(r.createdBy as string)
}

const rulesOf = (body: unknown): PermissionRuleView[] | null => {
  const rules = (body as { rules?: unknown } | undefined)?.rules
  return Array.isArray(rules) && rules.every(isRule) ? rules : null
}

/** Checks both response bodies; null when either is not a list of well-formed rules. */
export function parsePermissionLists(activeBody: unknown, historyBody: unknown): { active: PermissionRuleView[]; history: PermissionRuleView[] } | null {
  const active = rulesOf(activeBody)
  const history = rulesOf(historyBody)
  return active && history ? { active, history } : null
}

/** Applies one `permission.changed` event. The event carries the rule as it now is, so its `state` decides the list; applying it twice gives the same result. */
export function applyPermissionEvent(s: PermissionsState, e: PermissionChangedEvent): PermissionsState {
  const { rule } = e
  const others = s.active.filter((r) => r.id !== rule.id)
  if (rule.state === 'active') {
    const at = s.active.findIndex((r) => r.id === rule.id)
    if (at >= 0) return { ...s, active: s.active.map((r, i) => (i === at ? rule : r)), history: s.history.filter((r) => r.id !== rule.id) }
    const next = others.findIndex((r) => r.createdAt > rule.createdAt)
    const active = next < 0 ? [...others, rule] : [...others.slice(0, next), rule, ...others.slice(next)]
    return { ...s, active, history: s.history.filter((r) => r.id !== rule.id) }
  }
  return { ...s, active: others, history: [rule, ...s.history.filter((r) => r.id !== rule.id)].slice(0, HISTORY_LIMIT) }
}
