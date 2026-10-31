import { describe, expect, it } from 'vitest'
import { defaultRules } from './defaults'
import { evaluate } from './engine'
import { parsePermissions, serializePermissions } from './storage'
import type { PermissionRule } from './types'

const NOW = '2026-11-01T10:00:00.000Z'
const DIGEST = 'c'.repeat(64)
const base = (o: Partial<PermissionRule>): PermissionRule => ({
  id: 'x1', scope: 'global', effect: 'allow', tool: 'Read', agentId: null, taskId: null, pathPattern: null, digest: null,
  createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, ...o,
})
const file = (rules: unknown[], schemaVersion: unknown = 1) => ({ schemaVersion, rules })

describe('defaultRules', () => {
  it('seeds the eight global defaults', () => {
    const rules = defaultRules(NOW)
    expect(rules.map((r) => [r.tool, r.effect])).toEqual([
      ['Read', 'allow'], ['Glob', 'allow'], ['Grep', 'allow'], ['Write', 'ask'], ['Edit', 'ask'], ['Bash', 'deny'], ['WebFetch', 'deny'], ['WebSearch', 'deny'],
    ])
    expect(rules.every((r) => r.scope === 'global' && r.createdBy === 'default' && r.createdAt === NOW)).toBe(true)
    expect(rules.map((r) => r.id)).toEqual(['default-read', 'default-glob', 'default-grep', 'default-write', 'default-edit', 'default-bash', 'default-webfetch', 'default-websearch'])
  })
  it('evaluates like the policy of today', () => {
    const q = { agentId: 'a', taskId: 't', digest: DIGEST, paths: ['x'] }
    const rules = defaultRules(NOW)
    expect(evaluate(rules, { ...q, tool: 'Read' }, NOW).effect).toBe('allow')
    expect(evaluate(rules, { ...q, tool: 'Write' }, NOW).effect).toBe('ask')
    expect(evaluate(rules, { ...q, tool: 'Bash' }, NOW).effect).toBe('deny')
  })
})

describe('serializePermissions and parsePermissions', () => {
  it('round-trips defaults, a task rule, an expired rule and a used once-rule', () => {
    const rules = [
      ...defaultRules(NOW),
      base({ id: 't1', scope: 'task', agentId: 'a1', taskId: 'k1', tool: 'Write', pathPattern: 'src/**', reason: 'ok' }),
      base({ id: 'e1', expiresAt: '2026-11-01T09:00:00.000Z' }),
      base({ id: 'o1', scope: 'once', agentId: 'a1', taskId: 'k1', tool: 'Edit', digest: DIGEST, usedAt: NOW }),
    ]
    expect(parsePermissions(JSON.parse(serializePermissions(rules)))).toEqual(rules)
  })

  const good = () => base({ id: 'g1' })
  it.each<[string, unknown]>([
    ['not an object', 5],
    ['wrong schema version', file([], 2)],
    ['rules not an array', { schemaVersion: 1, rules: {} }],
    ['unknown scope', file([{ ...good(), scope: 'galaxy' }])],
    ['unknown effect', file([{ ...good(), effect: 'maybe' }])],
    ['non-string tool', file([{ ...good(), tool: 7 }])],
    ['once rule without a digest', file([base({ id: 'o', scope: 'once', agentId: 'a', taskId: 't' })])],
    ['global rule with an agent', file([base({ id: 'g', agentId: 'a' })])],
    ['duplicate id', file([good(), good()])],
    ['unparseable createdAt', file([{ ...good(), createdAt: 'yesterday' }])],
    ['extra unknown field', file([{ ...good(), extra: true }])],
    ['allow on an execute tool outside once', file([base({ id: 'b', tool: 'Bash' })])],
    ['allow on a network tool at agent scope', file([base({ id: 'w', scope: 'agent', agentId: 'a', tool: 'WebFetch' })])],
  ])('returns null for %s', (_name, raw) => {
    expect(parsePermissions(raw)).toBeNull()
  })

  it('accepts the good rule on its own', () => {
    expect(parsePermissions(file([good()]))).toEqual([good()])
  })
})
