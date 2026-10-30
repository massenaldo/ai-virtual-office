import { describe, expect, it } from 'vitest'
import { LAYOUT_STORAGE_KEY } from '../layout/storage'
import { createDemoWorkforce } from './demo'
import { addActivity, applyRuntimeEvent, assignTask, INTERRUPTED_MESSAGE, removeAgent } from './operations'
import { loadWorkforce, parseWorkforce, saveWorkforce, serializeWorkforce, WORKFORCE_BACKUP_KEY, WORKFORCE_STORAGE_KEY } from './storage'
import type { WorkforceState } from './types'

const NOW = '2026-10-30T09:00:00.000Z'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const touched: string[] = []
  return {
    data,
    touched,
    getItem: (k: string) => { touched.push(k); return data.get(k) ?? null },
    setItem: (k: string, v: string) => { touched.push(k); data.set(k, v) },
  }
}

function withRunningTask(): { state: WorkforceState; taskId: string } {
  const r = assignTask(createDemoWorkforce(NOW), 'agent-demo-backend', { title: 'Build API', description: 'REST endpoints' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: applyRuntimeEvent(r.state, { type: 'started', taskId: r.taskId, executionId: 'exec-1' }, NOW, 'mock'), taskId: r.taskId }
}

const roundTrip = (s: WorkforceState) => parseWorkforce(JSON.parse(serializeWorkforce(s)))

describe('loadWorkforce', () => {
  it('seeds the demo once when nothing is stored', () => {
    const s = memoryStorage()
    const first = loadWorkforce(s, NOW)
    expect(first).toMatchObject({ seeded: true, problem: null })
    expect(first.state.agents).toHaveLength(6)
    expect(saveWorkforce(s, first.state).ok).toBe(true)
    const emptied = first.state.agents.reduce((st, a) => removeAgent(st, a.id).state, first.state)
    expect(saveWorkforce(s, emptied).ok).toBe(true)
    const again = loadWorkforce(s, NOW)
    expect(again).toMatchObject({ seeded: false, problem: null })
    expect(again.state.agents).toHaveLength(0)
  })

  it('reports unavailable storage without seeding', () => {
    const r = loadWorkforce(null, NOW)
    expect(r).toMatchObject({ seeded: false, problem: 'unavailable' })
    expect(r.state.agents).toEqual([])
  })

  it('round-trips a state with tasks and activities', () => {
    const s = memoryStorage()
    const { state } = withRunningTask()
    const done = applyRuntimeEvent(state, { type: 'completed', taskId: state.tasks[0].id, summary: 'Simulated' }, NOW, 'mock')
    saveWorkforce(s, done)
    expect(loadWorkforce(s, NOW)).toEqual({ state: done, seeded: false, problem: null })
  })

  it('never touches the layout key', () => {
    const s = memoryStorage()
    saveWorkforce(s, loadWorkforce(s, NOW).state)
    loadWorkforce(s, NOW)
    expect(s.touched).not.toContain(LAYOUT_STORAGE_KEY)
    expect(new Set(s.touched)).toEqual(new Set([WORKFORCE_STORAGE_KEY]))
  })

  it('backs up corrupt data once and starts empty', () => {
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: '{not json' })
    const r = loadWorkforce(s, NOW)
    expect(r).toMatchObject({ seeded: false, problem: 'corrupt' })
    expect(r.state.agents).toEqual([])
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe('{not json')
    s.data.set(WORKFORCE_STORAGE_KEY, '{"other":1}')
    expect(loadWorkforce(s, NOW).problem).toBe('corrupt')
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe('{not json')
  })

  it('treats a newer schemaVersion as unsupported-version', () => {
    const json = JSON.stringify({ ...JSON.parse(serializeWorkforce(createDemoWorkforce(NOW))), schemaVersion: 2 })
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: json })
    expect(loadWorkforce(s, NOW)).toMatchObject({ seeded: false, problem: 'unsupported-version' })
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe(json)
  })

  it('still loads when writing the backup fails', () => {
    const s = { getItem: (k: string) => (k === WORKFORCE_STORAGE_KEY ? 'bad' : null), setItem: () => { throw new Error('full') } }
    expect(loadWorkforce(s, NOW).problem).toBe('corrupt')
  })

  it('recovers interrupted tasks on load', () => {
    const s = memoryStorage()
    saveWorkforce(s, withRunningTask().state)
    const task = loadWorkforce(s, NOW).state.tasks[0]
    expect(task).toMatchObject({ status: 'failed', errorMessage: INTERRUPTED_MESSAGE })
  })
})

describe('parseWorkforce', () => {
  const valid = () => JSON.parse(serializeWorkforce(withRunningTask().state))

  it('accepts a valid state', () => {
    expect(parseWorkforce(valid())).not.toBeNull()
  })

  it.each([
    ['a task for an unknown agent', (r: any) => { r.tasks[0].agentId = 'agent-x' }],
    ['an activity for an unknown task', (r: any) => { r.activities[0].taskId = 'task-x' }],
    ['an activity for an unknown agent', (r: any) => { r.activities[0].agentId = 'agent-x' }],
    ['a currentTaskId that does not exist', (r: any) => { r.agents[0].currentTaskId = 'task-x' }],
    ['a currentTaskId owned by another agent', (r: any) => { r.agents.find((a: any) => a.id === 'agent-demo-qa').currentTaskId = r.tasks[0].id }],
    ['a duplicate deskId', (r: any) => { r.agents[1].deskId = r.agents[0].deskId }],
    ['two active tasks for one agent', (r: any) => { r.tasks.push({ ...r.tasks[0], id: 'task-2', status: 'queued' }) }],
    ['a duplicate id', (r: any) => { r.tasks[0].id = r.agents[0].id }],
    ['an invalid agent status', (r: any) => { r.agents[0].status = 'sleeping' }],
    ['an invalid task status', (r: any) => { r.tasks[0].status = 'paused' }],
    ['an unknown activity type', (r: any) => { r.activities[0].type = 'teleported' }],
    ['a bad timestamp', (r: any) => { r.tasks[0].createdAt = 'yesterday' }],
    ['the meeting department', (r: any) => { r.agents[0].department = 'meeting' }],
    ['a missing desk-assigned deskId', (r: any) => { r.activities.push({ id: 'activity-x', agentId: r.agents[0].id, taskId: null, type: 'desk-assigned', message: 'x', timestamp: NOW, source: 'mock' }) }],
  ])('rejects %s', (_label, mutate) => {
    const raw = valid()
    mutate(raw)
    expect(parseWorkforce(raw)).toBeNull()
  })
})

describe('saveWorkforce', () => {
  it('caps activities at 300 when saving', () => {
    let state = createDemoWorkforce(NOW)
    for (let i = 0; i < 320; i++) state = { ...state, activities: [...state.activities, { ...state.activities[0], id: `activity-${i}`, message: `#${i}` }] }
    const s = memoryStorage()
    expect(saveWorkforce(s, state).ok).toBe(true)
    const saved = JSON.parse(s.data.get(WORKFORCE_STORAGE_KEY)!)
    expect(saved.activities).toHaveLength(300)
    expect(saved.activities.at(-1).message).toBe('#319')
    expect(roundTrip(addActivity(state, { ...state.activities[0], message: 'x' }))).not.toBeNull()
  })

  it('returns an error when setItem throws', () => {
    const s = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(saveWorkforce(s, createDemoWorkforce(NOW))).toEqual({ ok: false, error: 'QuotaExceededError' })
  })

  it('reports missing storage', () => {
    expect(saveWorkforce(null, createDemoWorkforce(NOW))).toEqual({ ok: false, error: 'Browser storage is not available.' })
  })
})
