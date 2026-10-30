import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import type { OfficeLayout } from '../layout/types'
import { createDemoWorkforce } from './demo'
import { addActivity, assignTask, cancelTask } from './operations'
import { AGENT_DEPARTMENTS, AGENT_STATUS_LABEL, agentHistory, agentTimeline, deskOptions, deskStatus, filterAgents, formatTime, removalPrompt, TASK_STATUS_LABEL } from './view'

const NOW = '2026-10-30T09:00:00.000Z'
const layout = createDefaultLayout()
const demo = createDemoWorkforce(NOW)
const without = (l: OfficeLayout, id: string): OfficeLayout => ({ ...l, furniture: l.furniture.filter((f) => f.id !== id) })
const agent = (id: string) => demo.agents.find((a) => a.id === id)!

function withTask(agentId = 'agent-demo-pm') {
  const r = assignTask(demo, agentId, { title: 'Draft sprint plan', description: '' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: r.state, taskId: r.taskId }
}

describe('labels', () => {
  it('covers every status and department except meeting', () => {
    expect(AGENT_STATUS_LABEL).toEqual({ idle: 'Idle', working: 'Working', thinking: 'Thinking', waiting: 'Waiting', error: 'Error', completed: 'Completed' })
    expect(TASK_STATUS_LABEL).toEqual({ queued: 'Queued', running: 'Running', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })
    expect(AGENT_DEPARTMENTS).not.toContain('meeting')
    expect(AGENT_DEPARTMENTS).toHaveLength(9)
    expect(AGENT_DEPARTMENTS[0]).toBe('executive')
  })
})

describe('filterAgents', () => {
  it('filters by department and status', () => {
    expect(filterAgents(demo.agents, { department: 'qa', status: 'all' }).map((a) => a.id)).toEqual(['agent-demo-qa'])
    expect(filterAgents(demo.agents, { department: 'all', status: 'working' })).toEqual([])
    expect(filterAgents(demo.agents, { department: 'all', status: 'idle' })).toHaveLength(6)
    expect(filterAgents(demo.agents, { department: 'all', status: 'all' })).toHaveLength(6)
  })
})

describe('deskOptions', () => {
  it("lists free desks by room plus the agent's own", () => {
    const groups = deskOptions(layout, demo, 'agent-demo-pm')
    const ids = (roomId: string | null) => groups.find((g) => g.roomId === roomId)?.desks.map((d) => d.id)
    expect(groups.map((g) => g.roomName)).toEqual(['CEO OFFICE', 'PROJECT MANAGEMENT', 'TECH LEAD', 'BACKEND ENGINEERING', 'Open floor'])
    expect(ids('room-ceo-office')).toEqual(['desk-01', 'desk-02'])
    expect(ids('room-project-management')).toEqual(['desk-03', 'desk-04'])
    expect(ids('room-tech-lead')).toEqual(['desk-06'])
    expect(ids(null)).toEqual(['desk-10', 'desk-12', 'desk-14'])
    expect(groups.flatMap((g) => g.desks).some((d) => d.id === 'desk-05')).toBe(false)
    expect(groups[1].desks[0]).toEqual({ id: 'desk-03', label: 'Desk 03' })
  })

  it('only offers desks that exist in the layout', () => {
    const groups = deskOptions(without(layout, 'desk-04'), demo, 'agent-demo-pm')
    expect(groups.flatMap((g) => g.desks).some((d) => d.id === 'desk-04')).toBe(false)
  })

  it('labels desks without the default naming by id', () => {
    const l: OfficeLayout = { ...layout, furniture: [...layout.furniture, { id: 'desk-a1b2c3d4', type: 'desk', x: 0, z: 0, rotation: 0, roomId: null }] }
    expect(deskOptions(l, demo, 'agent-demo-pm').at(-1)?.desks.at(-1)).toEqual({ id: 'desk-a1b2c3d4', label: 'desk-a1b2c3d4' })
  })
})

describe('deskStatus', () => {
  it('reports assigned, none and unavailable', () => {
    expect(deskStatus(layout, agent('agent-demo-pm'))).toEqual({ kind: 'assigned', label: 'Desk 03', roomName: 'PROJECT MANAGEMENT' })
    expect(deskStatus(layout, agent('agent-demo-qa'))).toEqual({ kind: 'assigned', label: 'Desk 13', roomName: 'Open floor' })
    expect(deskStatus(without(layout, 'desk-03'), agent('agent-demo-pm'))).toEqual({ kind: 'unavailable', deskId: 'desk-03' })
    expect(deskStatus(layout, { ...agent('agent-demo-pm'), deskId: null })).toEqual({ kind: 'none' })
  })

  it('treats a non-desk furniture id as unavailable', () => {
    expect(deskStatus(layout, { ...agent('agent-demo-pm'), deskId: 'chair-03' })).toEqual({ kind: 'unavailable', deskId: 'chair-03' })
  })
})

describe('timeline and history', () => {
  it('agentTimeline is newest first and limited', () => {
    let s = demo
    for (let i = 0; i < 25; i++) s = addActivity(s, { type: 'agent-updated', agentId: 'agent-demo-pm', taskId: null, message: `#${i}`, timestamp: NOW, source: 'mock' })
    const t = agentTimeline(s, 'agent-demo-pm')
    expect(t).toHaveLength(20)
    expect(t[0].message).toBe('#24')
    expect(agentTimeline(s, 'agent-demo-pm', 3).map((a) => a.message)).toEqual(['#24', '#23', '#22'])
    expect(agentTimeline(s, 'agent-demo-qa')).toHaveLength(1)
  })

  it('agentHistory is newest first', () => {
    const { state, taskId } = withTask()
    const second = assignTask(cancelTask(state, taskId, NOW), 'agent-demo-pm', { title: 'Second', description: '' }, NOW)
    if (!second.ok) throw new Error(second.error)
    expect(agentHistory(second.state, 'agent-demo-pm').map((t) => t.title)).toEqual(['Second', 'Draft sprint plan'])
    expect(agentHistory(second.state, 'agent-demo-qa')).toEqual([])
  })
})

describe('removalPrompt', () => {
  it('asks only when there is a task', () => {
    expect(removalPrompt(demo, 'agent-demo-pm')).toBeNull()
    const { state, taskId } = withTask()
    expect(removalPrompt(state, 'agent-demo-pm')).toEqual({ title: 'Remove Atlas?', message: 'Atlas is running "Draft sprint plan". Removing the agent cancels the task and deletes its history.' })
    expect(removalPrompt(cancelTask(state, taskId, NOW), 'agent-demo-pm')).toEqual({ title: 'Remove Atlas?', message: 'This deletes Atlas and its task history.' })
    expect(removalPrompt(demo, 'agent-x')).toBeNull()
  })
})

describe('formatTime', () => {
  it('gives HH:MM:SS', () => {
    expect(formatTime(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})
