import { TOOL_CATALOGUE } from '../toolPolicy'
import { isValidPathPattern } from './pathPattern'
import { PATTERN_MAX_CHARS, REASON_MAX_CHARS, type PermissionRule } from './types'

export const PERMISSIONS_SCHEMA_VERSION = 1

export function serializePermissions(rules: readonly PermissionRule[]): string {
  return `${JSON.stringify({ schemaVersion: PERMISSIONS_SCHEMA_VERSION, rules }, null, 2)}\n`
}

const KEYS: ReadonlyArray<keyof PermissionRule> = ['id', 'scope', 'effect', 'tool', 'agentId', 'taskId', 'pathPattern', 'digest', 'createdAt', 'createdBy', 'expiresAt', 'revokedAt', 'usedAt', 'endedAt', 'reason']
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v !== '' && v.length <= max
const nullableText = (v: unknown, max = 256): boolean => v === null || text(v, max)
const date = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v))
const nullableDate = (v: unknown): boolean => v === null || date(v)

function parseRule(raw: unknown): PermissionRule | null {
  if (!isObject(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== KEYS.length || !KEYS.every((k) => k in raw)) return null
  const r = raw as Record<keyof PermissionRule, unknown>
  if (!text(r.id, 64) || !text(r.tool, 64) || !TOOL_CATALOGUE.some((t) => t.name === r.tool)) return null
  if (!['global', 'agent', 'task', 'once'].includes(r.scope as string) || !['allow', 'deny', 'ask'].includes(r.effect as string)) return null
  if (!['default', 'user', 'system'].includes(r.createdBy as string)) return null
  if (!nullableText(r.agentId, 64) || !nullableText(r.taskId, 64) || !nullableText(r.reason, REASON_MAX_CHARS)) return null
  if (!date(r.createdAt) || !nullableDate(r.expiresAt) || !nullableDate(r.revokedAt) || !nullableDate(r.usedAt) || !nullableDate(r.endedAt)) return null
  if (r.pathPattern !== null && (typeof r.pathPattern !== 'string' || r.pathPattern.length > PATTERN_MAX_CHARS || !isValidPathPattern(r.pathPattern))) return null
  if (r.digest !== null && (typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest))) return null
  // The same shape rules validateGrant enforces, so a hand-edited file cannot hold a rule the API would refuse.
  const { scope, agentId, taskId, digest } = r
  if (scope === 'global' && (agentId !== null || taskId !== null)) return null
  if (scope !== 'global' && agentId === null) return null
  if ((scope === 'task' || scope === 'once') && taskId === null) return null
  if (scope === 'agent' && taskId !== null) return null
  if ((scope === 'once') !== (digest !== null)) return null
  if (scope === 'once' && (r.effect !== 'allow' || r.pathPattern !== null)) return null
  const category = TOOL_CATALOGUE.find((t) => t.name === r.tool)!.category
  if (r.effect === 'allow' && (category === 'execute' || category === 'network') && scope !== 'once') return null
  return raw as PermissionRule
}

/** Strict: any problem anywhere makes the whole file `null` (corrupt), never a partial list. */
export function parsePermissions(raw: unknown): PermissionRule[] | null {
  if (!isObject(raw) || raw.schemaVersion !== PERMISSIONS_SCHEMA_VERSION || !Array.isArray(raw.rules)) return null
  const rules: PermissionRule[] = []
  const seen = new Set<string>()
  for (const item of raw.rules) {
    const rule = parseRule(item)
    if (!rule || seen.has(rule.id)) return null
    seen.add(rule.id)
    rules.push(rule)
  }
  return rules
}
