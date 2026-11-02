import { describe, expect, it } from 'vitest'
import { applyWorkforceEvent, parseEventId, WORKFORCE_EVENT_TYPES, type ChangeEvent, type PermissionChangedEvent, type WorkforcePatch } from './api'
import { createDemoWorkforce } from './demo'
import { addActivity, assignTask } from './operations'
import { ACTIVITY_LIMIT, type WorkforceState } from './types'

const NOW = '2026-10-31T09:00:00.000Z'
const empty: WorkforcePatch = { agents: [], tasks: [], activities: [], removedAgentIds: [] }
const event = (patch: Partial<WorkforcePatch>): ChangeEvent => ({ id: 'boot:1', type: 'state.changed', at: NOW, agentId: null, taskId: null, patch: { ...empty, ...patch } })

describe('parseEventId', () => {
  it('reads boot and seq', () => {
    expect(parseEventId('k3x9:42')).toEqual({ boot: 'k3x9', seq: 42 })
    expect(parseEventId('k3x9:0')).toEqual({ boot: 'k3x9', seq: 0 })
    for (const bad of ['x', 'a:-1', 'a:1.5', ':3', 'a:b', '']) expect(parseEventId(bad)).toBeNull()
  })
})

describe('applyWorkforceEvent', () => {
  const demo = createDemoWorkforce(NOW)

  it('upserts, appends and removes', () => {
    const forge = demo.agents.find((a) => a.id === 'agent-demo-backend')!
    const r = assignTask(demo, forge.id, { title: 'Build API', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    const task = r.state.tasks[0]
    const activity = r.state.activities.at(-1)!
    const updated = { ...forge, name: 'Forge Two' }

    const s1 = applyWorkforceEvent(demo, event({ agents: [updated], tasks: [task], activities: [activity] }))
    expect(s1.agents.find((a) => a.id === forge.id)?.name).toBe('Forge Two')
    expect(s1.agents).toHaveLength(6)
    expect(s1.tasks).toEqual([task])
    expect(s1.activities.at(-1)).toEqual(activity)

    const s2 = applyWorkforceEvent(s1, event({ removedAgentIds: [forge.id] }))
    expect(s2.agents.some((a) => a.id === forge.id)).toBe(false)
    expect(s2.tasks).toEqual([])
    expect(s2.activities.every((a) => a.agentId !== forge.id)).toBe(true)
  })

  it('appends a new agent in order', () => {
    const extra = { ...demo.agents[0], id: 'agent-new', deskId: null }
    expect(applyWorkforceEvent(demo, event({ agents: [extra] })).agents.at(-1)?.id).toBe('agent-new')
  })

  it('keeps the newest ACTIVITY_LIMIT activities', () => {
    let s: WorkforceState = demo
    for (let i = 0; i < ACTIVITY_LIMIT; i++) s = addActivity(s, { type: 'agent-updated', agentId: 'agent-demo-pm', taskId: null, message: `#${i}`, timestamp: NOW, source: 'mock' })
    const extra = addActivity(s, { type: 'agent-updated', agentId: 'agent-demo-pm', taskId: null, message: 'newest', timestamp: NOW, source: 'mock' }).activities.at(-1)!
    const next = applyWorkforceEvent(s, event({ activities: [extra] }))
    expect(next.activities).toHaveLength(ACTIVITY_LIMIT)
    expect(next.activities.at(-1)?.message).toBe('newest')
    expect(next.activities[0].message).toBe('#1')
  })

  it('state.reset returns the same state', () => {
    expect(applyWorkforceEvent(demo, { id: 'boot:2', type: 'state.reset', at: NOW, reason: 'gap' })).toBe(demo)
  })
})

describe('WORKFORCE_EVENT_TYPES', () => {
  it('lists every event type once', () => {
    expect(new Set(WORKFORCE_EVENT_TYPES).size).toBe(11)
    expect(WORKFORCE_EVENT_TYPES).toContain('state.reset')
    expect(WORKFORCE_EVENT_TYPES).toContain('task.waiting_for_approval')
  })
})

describe('applyWorkforceEvent: permission.changed', () => {
  it('leaves the workforce state untouched and WORKFORCE_EVENT_TYPES does not list it', () => {
    const state = createDemoWorkforce('2026-11-01T00:00:00.000Z')
    const event: PermissionChangedEvent = { id: 'b:1', type: 'permission.changed', at: 'x', kind: 'granted', rule: { id: 'p', scope: 'global', effect: 'deny', tool: 'Read', agentId: null, taskId: null, pathPattern: null, createdAt: 'x', createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active' } }
    expect(applyWorkforceEvent(state, event)).toBe(state)
    expect((WORKFORCE_EVENT_TYPES as readonly string[]).includes('permission.changed')).toBe(false)
  })
})
