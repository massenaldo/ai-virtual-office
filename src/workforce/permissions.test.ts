import { describe, expect, it } from 'vitest'
import type { PermissionChangedEvent, PermissionRuleView } from './api'
import { HISTORY_LIMIT, applyPermissionEvent, emptyPermissions, parsePermissionLists, withLists } from './permissions'

const T0 = '2026-11-03T09:00:00.000Z'
const rule = (id: string, over: Partial<PermissionRuleView> = {}): PermissionRuleView => ({ id, scope: 'global', effect: 'allow', tool: 'Read', agentId: null, taskId: null, pathPattern: null, createdAt: T0, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active', ...over })
const event = (kind: PermissionChangedEvent['kind'], r: PermissionRuleView): PermissionChangedEvent => ({ id: 'b1:1', type: 'permission.changed', at: T0, kind, rule: r })
const loaded = (active: PermissionRuleView[] = [], history: PermissionRuleView[] = []) => withLists(emptyPermissions(), active, history)

describe('applyPermissionEvent', () => {
  it('a granted rule joins the active list', () => {
    const s = applyPermissionEvent(loaded(), event('granted', rule('p1')))
    expect(s.active.map((r) => r.id)).toEqual(['p1'])
    expect(s.history).toEqual([])
  })

  it('a granted rule that is already listed is replaced in place, not duplicated', () => {
    const s = applyPermissionEvent(loaded([rule('p1', { createdAt: '2026-11-03T08:00:00.000Z' }), rule('p2')]), event('granted', rule('p1', { createdAt: '2026-11-03T08:00:00.000Z', reason: 'again' })))
    expect(s.active.map((r) => r.id)).toEqual(['p1', 'p2'])
    expect(s.active[0].reason).toBe('again')
  })

  it('keeps the active list oldest first', () => {
    const s = applyPermissionEvent(loaded([rule('p2', { createdAt: '2026-11-03T10:00:00.000Z' })]), event('granted', rule('p1', { createdAt: '2026-11-03T08:00:00.000Z' })))
    expect(s.active.map((r) => r.id)).toEqual(['p1', 'p2'])
  })

  it.each([['revoked', 'revoked'], ['used', 'used'], ['ended', 'ended'], ['expired', 'expired']] as const)('%s moves the rule to the front of history', (kind, state) => {
    const s = applyPermissionEvent(loaded([rule('p1'), rule('p2')], [rule('old', { state: 'revoked' })]), event(kind, rule('p1', { state })))
    expect(s.active.map((r) => r.id)).toEqual(['p2'])
    expect(s.history.map((r) => r.id)).toEqual(['p1', 'old'])
  })

  it('a task rule that was used but is still active stays active', () => {
    const s = applyPermissionEvent(loaded([rule('p1', { scope: 'task' })]), event('used', rule('p1', { scope: 'task', usedAt: T0 })))
    expect(s.active.map((r) => r.id)).toEqual(['p1'])
    expect(s.history).toEqual([])
  })

  it('an event for a rule that was never listed is placed by its own state', () => {
    expect(applyPermissionEvent(loaded(), event('revoked', rule('x', { state: 'revoked' }))).history.map((r) => r.id)).toEqual(['x'])
  })

  it('the same event twice changes nothing the second time', () => {
    const e = event('revoked', rule('p1', { state: 'revoked' }))
    const once = applyPermissionEvent(loaded([rule('p1')]), e)
    expect(applyPermissionEvent(once, e)).toEqual(once)
  })

  it('caps history at the newest HISTORY_LIMIT rules', () => {
    const history = Array.from({ length: HISTORY_LIMIT }, (_, i) => rule(`h${i}`, { state: 'revoked' }))
    const s = applyPermissionEvent(loaded([rule('p1')], history), event('revoked', rule('p1', { state: 'revoked' })))
    expect(s.history).toHaveLength(HISTORY_LIMIT)
    expect(s.history[0].id).toBe('p1')
    expect(s.history.at(-1)!.id).toBe(`h${HISTORY_LIMIT - 2}`)
  })

  it('keeps the loaded flag and clears nothing else', () => {
    const s = applyPermissionEvent(emptyPermissions(), event('granted', rule('p1')))
    expect(s.loaded).toBe(false)
  })
})

describe('parsePermissionLists', () => {
  it('accepts the two response bodies', () => {
    expect(parsePermissionLists({ rules: [rule('a')] }, { rules: [rule('b', { state: 'revoked' })] })).toEqual({ active: [rule('a')], history: [rule('b', { state: 'revoked' })] })
  })

  it.each([[undefined], [{}], [{ rules: 'x' }], [{ rules: [null] }], [{ rules: [{ id: 1 }] }], [{ rules: [{ ...rule('a'), state: 'weird' }] }]])('refuses a malformed body %j', (body) => {
    expect(parsePermissionLists(body, { rules: [] })).toBeNull()
    expect(parsePermissionLists({ rules: [] }, body)).toBeNull()
  })
})

describe('workspaceId in a rule view', () => {
  const lists = (r: unknown) => parsePermissionLists({ rules: [r] }, { rules: [] })
  it('accepts a workspace id, null, and a missing field (an older server)', () => {
    expect(lists(rule('a', { workspaceId: 'sandbox' }))).not.toBeNull()
    expect(lists(rule('a', { workspaceId: null }))).not.toBeNull()
    expect(lists(rule('a'))).not.toBeNull()
  })
  it.each([[5], [{}], [['x']], [false]])('rejects %j', (bad) => {
    expect(lists({ ...rule('a'), workspaceId: bad })).toBeNull()
  })
})

describe('runtime in a rule view', () => {
  const lists = (r: unknown) => parsePermissionLists({ rules: [r] }, { rules: [] })
  it('accepts mock, claude, null and a missing field (an older server)', () => {
    for (const runtime of ['mock', 'claude', null]) expect(lists(rule('a', { runtime } as never))).not.toBeNull()
    expect(lists(rule('a'))).not.toBeNull()
  })
  it.each([[5], [{}], [['mock']], [false], ['gpt'], ['']])('rejects %j', (bad) => {
    expect(lists({ ...rule('a'), runtime: bad })).toBeNull()
  })
})
