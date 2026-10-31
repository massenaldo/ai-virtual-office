import { describe, expect, it } from 'vitest'
import { evaluate, ruleState, validateGrant } from './engine'
import type { GrantError, GrantInput, PermissionQuery, PermissionRule } from './types'

const NOW = '2026-11-01T10:00:00.000Z'
const DIGEST = 'a'.repeat(64)
let n = 0
const rule = (o: Partial<PermissionRule> = {}): PermissionRule => ({
  id: `r${++n}`, scope: 'global', effect: 'allow', tool: 'Write', agentId: null, taskId: null, pathPattern: null, digest: null,
  createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, ...o,
})
const q = (o: Partial<PermissionQuery> = {}): PermissionQuery => ({ agentId: 'a1', taskId: 't1', tool: 'Write', digest: DIGEST, paths: ['src/x.ts'], ...o })

describe('ruleState', () => {
  it('orders revoked, used, ended, expired, active', () => {
    expect(ruleState(rule(), NOW)).toBe('active')
    expect(ruleState(rule({ revokedAt: NOW, usedAt: NOW }), NOW)).toBe('revoked')
    expect(ruleState(rule({ usedAt: NOW, endedAt: NOW }), NOW)).toBe('used')
    expect(ruleState(rule({ endedAt: NOW, expiresAt: '2026-01-01T00:00:00.000Z' }), NOW)).toBe('ended')
    expect(ruleState(rule({ expiresAt: '2026-01-01T00:00:00.000Z' }), NOW)).toBe('expired')
  })
  it('treats now === expiresAt as expired and one ms earlier as active', () => {
    expect(ruleState(rule({ expiresAt: NOW }), NOW)).toBe('expired')
    expect(ruleState(rule({ expiresAt: '2026-11-01T10:00:00.001Z' }), NOW)).toBe('active')
  })
})

describe('evaluate: precedence', () => {
  it('lets any deny beat allow at every scope', () => {
    const d = evaluate([rule({ effect: 'deny' }), rule({ scope: 'once', agentId: 'a1', taskId: 't1', digest: DIGEST })], q(), NOW)
    expect(d).toMatchObject({ effect: 'deny', source: 'deny_rule' })
  })
  it('lets agent beat global in both directions', () => {
    const a = rule({ scope: 'agent', agentId: 'a1' })
    expect(evaluate([rule({ effect: 'ask' }), a], q(), NOW)).toEqual({ effect: 'allow', source: 'agent', ruleId: a.id })
    const k = rule({ scope: 'agent', agentId: 'a1', effect: 'ask' })
    expect(evaluate([rule(), k], q(), NOW)).toEqual({ effect: 'ask', source: 'agent', ruleId: k.id })
  })
  it('lets task beat agent and once beat task', () => {
    const agent = rule({ scope: 'agent', agentId: 'a1', effect: 'ask' })
    const task = rule({ scope: 'task', agentId: 'a1', taskId: 't1' })
    const once = rule({ scope: 'once', agentId: 'a1', taskId: 't1', digest: DIGEST })
    expect(evaluate([agent, task], q(), NOW)).toMatchObject({ effect: 'allow', source: 'task', ruleId: task.id })
    expect(evaluate([agent, task, once], q(), NOW)).toMatchObject({ source: 'once', ruleId: once.id })
  })
  it('lets ask beat allow inside one scope', () => {
    expect(evaluate([rule(), rule({ effect: 'ask' })], q(), NOW).effect).toBe('ask')
  })
  it('defaults to deny when nothing matches', () => {
    expect(evaluate([], q(), NOW)).toEqual({ effect: 'deny', source: 'default', ruleId: null })
  })
  it('ignores other agents, other tasks and other tools', () => {
    const rules = [rule({ scope: 'agent', agentId: 'a2' }), rule({ scope: 'task', agentId: 'a1', taskId: 't2' }), rule({ tool: 'Edit' })]
    expect(evaluate(rules, q(), NOW).source).toBe('default')
  })
  it('needs the exact digest for a once rule', () => {
    const once = rule({ scope: 'once', agentId: 'a1', taskId: 't1', digest: 'b'.repeat(64) })
    expect(evaluate([once], q(), NOW).source).toBe('default')
  })
  it('ignores revoked, used, ended and expired rules', () => {
    const rules = [rule({ revokedAt: NOW }), rule({ usedAt: NOW }), rule({ endedAt: NOW }), rule({ expiresAt: NOW })]
    expect(evaluate(rules, q(), NOW).source).toBe('default')
  })
})

describe('evaluate: path patterns', () => {
  it('still denies a path-restricted deny when the call has no paths', () => {
    expect(evaluate([rule({ effect: 'deny', pathPattern: 'secrets/**' })], q({ paths: [] }), NOW).effect).toBe('deny')
  })
  it('does not match a path-restricted allow when the call has no paths', () => {
    expect(evaluate([rule({ pathPattern: 'src/**' })], q({ paths: [] }), NOW).source).toBe('default')
  })
  it('needs every path for allow and any path for deny', () => {
    const allow = rule({ pathPattern: 'src/**' })
    expect(evaluate([allow], q({ paths: ['src/a.ts', 'lib/b.ts'] }), NOW).source).toBe('default')
    expect(evaluate([allow], q({ paths: ['src/a.ts', 'src/b.ts'] }), NOW).effect).toBe('allow')
    expect(evaluate([rule({ effect: 'deny', pathPattern: 'secrets/**' })], q({ paths: ['src/a.ts', 'secrets/k'] }), NOW).effect).toBe('deny')
  })
  it('matches deny patterns case-insensitively and allow patterns case-sensitively', () => {
    expect(evaluate([rule({ effect: 'deny', pathPattern: 'secrets/**' })], q({ paths: ['SECRETS/k'] }), NOW).effect).toBe('deny')
    expect(evaluate([rule({ pathPattern: 'src/**' })], q({ paths: ['SRC/a.ts'] }), NOW).source).toBe('default')
  })
  it('lets a deny on secrets/** cover the folder path itself', () => {
    expect(evaluate([rule({ effect: 'deny', pathPattern: 'secrets/**' })], q({ paths: ['secrets'] }), NOW).effect).toBe('deny')
  })
})

describe('evaluate: failing closed', () => {
  it('denies with source error when a rule cannot be read', () => {
    const bad = rule({ effect: 'deny' })
    Object.defineProperty(bad, 'pathPattern', { get() { throw new Error('boom') } })
    expect(evaluate([bad], q(), NOW)).toEqual({ effect: 'deny', source: 'error', ruleId: null })
  })
})

describe('validateGrant', () => {
  const ok = (i: GrantInput) => validateGrant(i, NOW)
  const bad = (i: GrantInput, error: GrantError) => expect(ok(i)).toEqual({ ok: false, error })

  it('accepts the supported shapes', () => {
    expect(ok({ scope: 'global', effect: 'allow', tool: 'Read' })).toMatchObject({ ok: true, fields: { scope: 'global', createdBy: 'user', agentId: null, pathPattern: null } })
    expect(ok({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a1', pathPattern: 'src/**' }).ok).toBe(true)
    expect(ok({ scope: 'task', effect: 'allow', tool: 'Edit', agentId: 'a1', taskId: 't1', expiresAt: '2026-11-02T00:00:00.000Z' }).ok).toBe(true)
    expect(ok({ scope: 'once', effect: 'allow', tool: 'Bash', agentId: 'a1', taskId: 't1', digest: DIGEST }).ok).toBe(true)
  })
  it('refuses each malformed grant with its own error', () => {
    bad({ scope: 'global', effect: 'allow', tool: 'Nope' }, 'unknown_tool')
    bad({ scope: 'galaxy' as never, effect: 'allow', tool: 'Read' }, 'invalid_scope')
    bad({ scope: 'global', effect: 'allow', tool: 'Read', agentId: 'a1' }, 'invalid_scope')
    bad({ scope: 'global', effect: 'maybe' as never, tool: 'Read' }, 'invalid_effect')
    bad({ scope: 'once', effect: 'deny', tool: 'Write', agentId: 'a1', taskId: 't1', digest: DIGEST }, 'invalid_effect')
    bad({ scope: 'task', effect: 'ask', tool: 'Write', agentId: 'a1', taskId: 't1' }, 'invalid_effect')
    bad({ scope: 'agent', effect: 'allow', tool: 'Write' }, 'missing_agent')
    bad({ scope: 'task', effect: 'allow', tool: 'Write', agentId: 'a1' }, 'missing_task')
    bad({ scope: 'once', effect: 'allow', tool: 'Write', agentId: 'a1', taskId: 't1', digest: 'short' }, 'missing_digest')
    bad({ scope: 'agent', effect: 'allow', tool: 'Bash', agentId: 'a1' }, 'scope_not_allowed_for_tool')
    bad({ scope: 'global', effect: 'allow', tool: 'WebFetch' }, 'scope_not_allowed_for_tool')
    bad({ scope: 'once', effect: 'allow', tool: 'Write', agentId: 'a1', taskId: 't1', digest: DIGEST, pathPattern: 'src/**' }, 'invalid_pattern')
    bad({ scope: 'global', effect: 'allow', tool: 'Read', pathPattern: '../x' }, 'invalid_pattern')
    bad({ scope: 'global', effect: 'allow', tool: 'Read', expiresAt: '2026-01-01T00:00:00.000Z' }, 'invalid_expiry')
    bad({ scope: 'global', effect: 'allow', tool: 'Read', expiresAt: 'tomorrow' }, 'invalid_expiry')
    bad({ scope: 'global', effect: 'allow', tool: 'Read', reason: 'x'.repeat(201) }, 'invalid_reason')
  })
  it('still lets a deny on an execute tool be global', () => {
    expect(ok({ scope: 'global', effect: 'deny', tool: 'Bash' }).ok).toBe(true)
  })
})
