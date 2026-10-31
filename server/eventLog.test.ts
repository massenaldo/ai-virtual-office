import { describe, expect, it, vi } from 'vitest'
import type { EventDraft } from './deriveEvents'
import { EventLog } from './eventLog'
import type { PermissionRuleView } from '../src/workforce/api'
import { silentLogger } from './log'

const NOW = '2026-10-31T09:00:00.000Z'
const draft = (n: number): EventDraft => ({ type: 'state.changed', agentId: null, taskId: `task-${n}`, patch: { agents: [], tasks: [], activities: [], removedAgentIds: [] } })
const make = (capacity = 500) => new EventLog({ capacity, now: () => NOW, bootId: 'boot', log: silentLogger })
const ids = (r: ReturnType<EventLog['since']>) => (r.kind === 'replay' ? r.events.map((e) => e.id) : 'reset')

describe('EventLog', () => {
  it('starts at boot:0', () => {
    const log = make()
    expect(log.lastEventId).toBe('boot:0')
    expect(log.bootId).toBe('boot')
  })

  it('defaults the boot id to something that looks like a time in base36', () => {
    expect(new EventLog({ capacity: 5, now: () => NOW, log: silentLogger }).bootId).toMatch(/^[0-9a-z]+$/)
  })

  it('stamps increasing ids and at', () => {
    const log = make()
    const events = log.append([draft(1), draft(2), draft(3)])
    expect(events.map((e) => e.id)).toEqual(['boot:1', 'boot:2', 'boot:3'])
    expect(events.every((e) => e.at === NOW)).toBe(true)
    expect(log.lastEventId).toBe('boot:3')
  })

  it('since(null) replays nothing', () => {
    const log = make()
    log.append([draft(1), draft(2)])
    expect(log.since(null)).toEqual({ kind: 'replay', events: [] })
  })

  it('replays the events after a given id, in order', () => {
    const log = make()
    log.append([1, 2, 3, 4, 5].map(draft))
    expect(ids(log.since('boot:2'))).toEqual(['boot:3', 'boot:4', 'boot:5'])
    expect(ids(log.since(log.lastEventId))).toEqual([])
    expect(ids(log.since('boot:0'))).toEqual(['boot:1', 'boot:2', 'boot:3', 'boot:4', 'boot:5'])
  })

  it('drops the oldest past capacity', () => {
    const log = make(3)
    log.append([1, 2, 3, 4, 5].map(draft))
    expect(ids(log.since('boot:2'))).toEqual(['boot:3', 'boot:4', 'boot:5'])
    expect(ids(log.since('boot:1'))).toBe('reset')
  })

  it('resets for another boot, an id ahead, or garbage', () => {
    const log = make()
    log.append([draft(1), draft(2)])
    expect(log.since('other:1')).toEqual({ kind: 'reset' })
    expect(log.since('boot:9')).toEqual({ kind: 'reset' })
    expect(log.since('nonsense')).toEqual({ kind: 'reset' })
  })

  it('notifies subscribers in order and stops after unsubscribe', () => {
    const log = make()
    const seen: string[] = []
    const off = log.subscribe((e) => seen.push(e.id))
    expect(log.listenerCount()).toBe(1)
    log.append([draft(1), draft(2)])
    off()
    log.append([draft(3)])
    expect(seen).toEqual(['boot:1', 'boot:2'])
    expect(log.listenerCount()).toBe(0)
  })

  it("a throwing listener doesn't stop the others", () => {
    const errors = vi.fn()
    const log = new EventLog({ capacity: 10, now: () => NOW, bootId: 'boot', log: { ...silentLogger, error: errors } })
    const seen: string[] = []
    log.subscribe(() => { throw new Error('boom') })
    log.subscribe((e) => seen.push(e.id))
    log.append([draft(1)])
    expect(seen).toEqual(['boot:1'])
    expect(errors).toHaveBeenCalledTimes(1)
  })
})

const rule = (id: string): PermissionRuleView => ({ id, scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a1', taskId: null, pathPattern: null, createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active' })

describe('EventLog: permission events', () => {
  it('shares the id sequence with workforce events', () => {
    const log = make()
    const [a] = log.append([draft(1)])
    const p = log.appendPermission('granted', rule('perm-1'))
    const [b] = log.append([draft(2)])
    expect([a.id, p.id, b.id]).toEqual(['boot:1', 'boot:2', 'boot:3'])
    expect(p).toEqual({ id: 'boot:2', type: 'permission.changed', at: NOW, kind: 'granted', rule: rule('perm-1') })
  })

  it('replays them in order with the others, and tells listeners', () => {
    const log = make()
    const heard: string[] = []
    log.subscribe((e) => heard.push(e.type))
    log.append([draft(1)])
    log.appendPermission('revoked', rule('perm-1'))
    log.append([draft(2)])
    expect(heard).toEqual(['state.changed', 'permission.changed', 'state.changed'])
    const r = log.since('boot:1')
    expect(r.kind === 'replay' && r.events.map((e) => e.type)).toEqual(['permission.changed', 'state.changed'])
  })

  it('keeps only the newest events across both kinds', () => {
    const log = make(2)
    log.append([draft(1)])
    log.appendPermission('used', rule('perm-1'))
    log.appendPermission('ended', rule('perm-2'))
    expect(ids(log.since('boot:1'))).toEqual(['boot:2', 'boot:3'])
    expect(ids(log.since('boot:0'))).toBe('reset')
  })
})
