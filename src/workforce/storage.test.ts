import { describe, expect, it } from 'vitest'
import { LAYOUT_STORAGE_KEY } from '../layout/storage'
import { createDemoWorkforce } from './demo'
import { addActivity, applyRuntimeEvent, assignTask, INTERRUPTED_MESSAGE, markStarting, removeAgent } from './operations'
import { loadWorkforce, migrateWorkforceV1, parseWorkforce, saveWorkforce, serializeWorkforce, WORKFORCE_BACKUP_KEY, WORKFORCE_STORAGE_KEY, WORKFORCE_V1_KEY } from './storage'
import type { WorkforceState } from './types'

const NOW = '2026-10-30T09:00:00.000Z'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const touched: string[] = []
  const writes: string[] = []
  return {
    data,
    touched,
    writes,
    getItem: (k: string) => { touched.push(k); return data.get(k) ?? null },
    setItem: (k: string, v: string) => { touched.push(k); writes.push(k); data.set(k, v) },
  }
}

function withRunningTask(): { state: WorkforceState; taskId: string } {
  const r = assignTask(createDemoWorkforce(NOW), 'agent-demo-backend', { title: 'Build API', description: 'REST endpoints' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: applyRuntimeEvent(markStarting(r.state, r.taskId, NOW), { type: 'started', taskId: r.taskId, executionId: 'exec-1' }, NOW, 'mock'), taskId: r.taskId }
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
    expect(loadWorkforce(s, NOW)).toEqual({ state: done, seeded: false, migrated: false, problem: null, preserved: null })
  })

  it('never touches the layout key', () => {
    const s = memoryStorage()
    saveWorkforce(s, loadWorkforce(s, NOW).state)
    loadWorkforce(s, NOW)
    expect(s.touched).not.toContain(LAYOUT_STORAGE_KEY)
    expect(new Set(s.touched)).toEqual(new Set([WORKFORCE_STORAGE_KEY, WORKFORCE_V1_KEY]))
    expect(s.writes.every((k) => k === WORKFORCE_STORAGE_KEY)).toBe(true)
    expect(WORKFORCE_STORAGE_KEY).toBe('ai-virtual-office:workforce:v2')
  })

  it('backs up corrupt data once and starts empty', () => {
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: '{not json' })
    const r = loadWorkforce(s, NOW)
    expect(r).toMatchObject({ seeded: false, problem: 'corrupt', preserved: 'backup-created' })
    expect(r.state.agents).toEqual([])
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe('{not json')
    s.data.set(WORKFORCE_STORAGE_KEY, '{"other":1}')
    expect(loadWorkforce(s, NOW)).toMatchObject({ problem: 'corrupt', preserved: 'backup-exists' })
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe('{not json')
  })

  it('reports backup-created when the backup already holds this exact data', () => {
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: '{bad' })
    expect(loadWorkforce(s, NOW).preserved).toBe('backup-created')
    expect(loadWorkforce(s, NOW).preserved).toBe('backup-created')
  })

  it('treats a newer schemaVersion as unsupported-version', () => {
    const json = JSON.stringify({ ...JSON.parse(serializeWorkforce(createDemoWorkforce(NOW))), schemaVersion: 3 })
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: json })
    expect(loadWorkforce(s, NOW)).toMatchObject({ seeded: false, problem: 'unsupported-version' })
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe(json)
  })

  it('still loads when writing the backup fails', () => {
    const s = { getItem: (k: string) => (k === WORKFORCE_STORAGE_KEY ? 'bad' : null), setItem: () => { throw new Error('full') } }
    expect(loadWorkforce(s, NOW)).toMatchObject({ problem: 'corrupt', preserved: 'left-in-place' })
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
    ['a pendingApproval on a running task', (r: any) => { r.tasks[0].pendingApproval = { id: 'a', tool: 'Write', summary: 'x', requestedAt: NOW } }],
    ['a waiting task without pendingApproval', (r: any) => { r.tasks[0].status = 'waiting_for_approval' }],
    ['an endedReason on an active task', (r: any) => { r.tasks[0].endedReason = 'completed' }],
    ['a finished task without endedReason', (r: any) => { r.tasks[0].status = 'completed' }],
    ['an unknown task runtime', (r: any) => { r.tasks[0].runtime = 'gpt' }],
    ['a non-positive timeout', (r: any) => { r.tasks[0].timeoutMs = 0 }],
    ['the v1 waiting status', (r: any) => { r.tasks[0].status = 'waiting' }],
    ['an approval decision that is not approve or deny', (r: any) => { r.activities.push({ id: 'activity-y', agentId: r.tasks[0].agentId, taskId: r.tasks[0].id, type: 'task-approval-decided', approvalId: 'a', decision: 'maybe', message: 'x', timestamp: NOW, source: 'mock' }) }],
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

  it('keeps unreadable data when its backup cannot be written', () => {
    const data = new Map([[WORKFORCE_STORAGE_KEY, '{bad']])
    const s = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { if (k === WORKFORCE_BACKUP_KEY) throw new Error('full'); data.set(k, v) },
    }
    const loaded = loadWorkforce(s, NOW)
    expect(loaded.problem).toBe('corrupt')
    expect(saveWorkforce(s, createDemoWorkforce(NOW))).toEqual({ ok: false, error: 'full' })
    expect(data.get(WORKFORCE_STORAGE_KEY)).toBe('{bad')
  })

  it('backs up unreadable data before overwriting it', () => {
    const s = memoryStorage({ [WORKFORCE_STORAGE_KEY]: '{bad' })
    expect(saveWorkforce(s, createDemoWorkforce(NOW)).ok).toBe(true)
    expect(s.data.get(WORKFORCE_BACKUP_KEY)).toBe('{bad')
  })

  it('reports missing storage', () => {
    expect(saveWorkforce(null, createDemoWorkforce(NOW))).toEqual({ ok: false, error: 'Browser storage is not available.' })
  })
})

/** A hand-written v1 save: Forge with a completed task and Sentry mid-run and waiting, with a legacy task-waiting activity. */
function v1Json(): string {
  const agents = createDemoWorkforce(NOW).agents.map((a) => ({ ...a }))
  const forge = agents.find((a) => a.id === 'agent-demo-backend')!
  const sentry = agents.find((a) => a.id === 'agent-demo-qa')!
  forge.currentTaskId = 'task-done'; forge.status = 'completed'
  sentry.currentTaskId = 'task-wait'; sentry.status = 'waiting'
  const base = { description: '', createdAt: NOW, completedAt: null, resultSummary: null, errorMessage: null, executionId: 'exec-1' }
  return JSON.stringify({
    schemaVersion: 1,
    agents,
    tasks: [
      { ...base, id: 'task-done', agentId: forge.id, title: 'Build API', status: 'completed', startedAt: NOW, completedAt: NOW, resultSummary: 'Simulated result' },
      { ...base, id: 'task-wait', agentId: sentry.id, title: 'Run tests', status: 'waiting', startedAt: NOW },
    ],
    activities: [
      { id: 'activity-1', agentId: forge.id, taskId: 'task-done', type: 'task-completed', message: 'Simulated result', timestamp: NOW, source: 'mock' },
      { id: 'activity-2', agentId: sentry.id, taskId: 'task-wait', type: 'task-waiting', message: 'Waiting for input (simulated)', timestamp: NOW, source: 'mock' },
    ],
  })
}

describe('v1 migration', () => {
  it('migrates saved v1 data once and leaves the v1 key untouched', () => {
    const json = v1Json()
    const s = memoryStorage({ [WORKFORCE_V1_KEY]: json })
    const r = loadWorkforce(s, NOW)
    expect(r).toMatchObject({ seeded: false, migrated: true, problem: null, preserved: null })
    const done = r.state.tasks.find((t) => t.id === 'task-done')!
    expect(done).toMatchObject({ status: 'completed', endedReason: 'completed', timeoutMs: null, runtime: 'mock', sessionId: null, pendingApproval: null })
    expect(s.writes).toEqual([])
    expect(saveWorkforce(s, r.state).ok).toBe(true)
    expect(s.data.get(WORKFORCE_V1_KEY)).toBe(json)
    expect(s.writes).toEqual([WORKFORCE_STORAGE_KEY])
    expect(loadWorkforce(s, NOW).migrated).toBe(false)
  })

  it('migrates a waiting task and task-waiting activity, then recovery fails the run', () => {
    const r = loadWorkforce(memoryStorage({ [WORKFORCE_V1_KEY]: v1Json() }), NOW)
    expect(r.state.tasks.find((t) => t.id === 'task-wait')).toMatchObject({ status: 'failed', endedReason: 'failed', errorMessage: INTERRUPTED_MESSAGE, pendingApproval: null })
    expect(r.state.activities.find((a) => a.id === 'activity-2')).toMatchObject({ type: 'task-approval-requested', approvalId: 'legacy-task-wait' })
    const migrated = migrateWorkforceV1(JSON.parse(v1Json())) as any
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.tasks[1]).toMatchObject({ status: 'waiting_for_approval', pendingApproval: { id: 'legacy-task-wait', tool: 'unknown', summary: 'Waiting for input (from an earlier version)', requestedAt: NOW } })
    expect(parseWorkforce(migrated)).not.toBeNull()
  })

  it('leaves corrupt v1 data in place and writes nothing', () => {
    const s = memoryStorage({ [WORKFORCE_V1_KEY]: '{broken' })
    const r = loadWorkforce(s, NOW)
    expect(r).toMatchObject({ seeded: false, migrated: false, problem: 'corrupt', preserved: 'left-in-place' })
    expect(r.state.agents).toEqual([])
    expect(s.writes).toEqual([])
    expect(s.data.get(WORKFORCE_V1_KEY)).toBe('{broken')
  })

  it('prefers v2 data over v1', () => {
    const s = memoryStorage({ [WORKFORCE_V1_KEY]: v1Json() })
    saveWorkforce(s, createDemoWorkforce(NOW))
    expect(loadWorkforce(s, NOW)).toMatchObject({ migrated: false })
    expect(loadWorkforce(s, NOW).state.tasks).toEqual([])
  })
})

describe('task workspaceId', () => {
  const withTaskField = (mutate: (task: Record<string, unknown>) => void) => {
    const raw = JSON.parse(serializeWorkforce(withRunningTask().state))
    mutate(raw.tasks[0])
    return raw
  }

  it('loads a v2 task without workspaceId as null', () => {
    const raw = withTaskField((t) => { delete t.workspaceId })
    expect(parseWorkforce(raw)?.tasks[0].workspaceId).toBeNull()
  })

  it('round-trips workspaceId', () => {
    const raw = withTaskField((t) => { t.workspaceId = 'sandbox' })
    const parsed = parseWorkforce(raw)!
    expect(parsed.tasks[0].workspaceId).toBe('sandbox')
    expect(JSON.parse(serializeWorkforce(parsed)).tasks[0].workspaceId).toBe('sandbox')
  })

  it('rejects a non-string workspaceId', () => {
    expect(parseWorkforce(withTaskField((t) => { t.workspaceId = 5 }))).toBeNull()
  })
})

