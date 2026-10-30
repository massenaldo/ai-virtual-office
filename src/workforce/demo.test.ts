import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { createDemoWorkforce, DEMO_AGENTS, restoreDemoAgents } from './demo'
import { assignDesk, createAgent, removeAgent } from './operations'

const NOW = '2026-10-30T09:00:00.000Z'

describe('createDemoWorkforce', () => {
  it('seeds six labelled demo agents on distinct default desks', () => {
    const s = createDemoWorkforce(NOW)
    const desks = new Set(createDefaultLayout().furniture.filter((f) => f.type === 'desk').map((f) => f.id))
    expect(s.agents).toHaveLength(6)
    expect(s.agents.map((a) => a.department).sort()).toEqual(['backend', 'devops', 'frontend', 'project-management', 'qa', 'tech-lead'])
    expect(s.agents.every((a) => a.demo && a.runtimeMode === 'mock' && a.status === 'idle' && a.createdAt === NOW)).toBe(true)
    expect(s.agents.every((a) => a.deskId !== null && desks.has(a.deskId))).toBe(true)
    expect(new Set(s.agents.map((a) => a.deskId)).size).toBe(6)
    expect(new Set(s.agents.map((a) => a.id)).size).toBe(6)
    expect(s.activities).toHaveLength(6)
    expect(s.activities.every((a) => a.type === 'agent-created' && a.source === 'mock' && a.message === 'Demo agent added (mock data)')).toBe(true)
    expect(s.tasks).toEqual([])
  })

  it('builds fresh objects each call', () => {
    expect(createDemoWorkforce(NOW).agents[0]).not.toBe(createDemoWorkforce(NOW).agents[0])
    expect(DEMO_AGENTS).toHaveLength(6)
  })
})

describe('restoreDemoAgents', () => {
  it('re-adds only missing demo agents', () => {
    let s = removeAgent(createDemoWorkforce(NOW), 'agent-demo-qa').state
    const user = createAgent(s, { name: 'Mine', role: 'Tester', department: 'qa' }, NOW)
    if (!user.ok) throw new Error(user.error)
    const seated = assignDesk(user.state, user.id, 'desk-13', NOW)
    if (!seated.ok) throw new Error(seated.error)
    s = seated.state
    const restored = restoreDemoAgents(s, NOW)
    expect(restored.agents).toHaveLength(7)
    expect(restored.agents.find((a) => a.id === 'agent-demo-qa')).toMatchObject({ deskId: null, demo: true })
    expect(restored.agents.find((a) => a.id === user.id)?.deskId).toBe('desk-13')
    expect(restoreDemoAgents(restored, NOW)).toBe(restored)
  })
})
