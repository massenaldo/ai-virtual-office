import { describe, expect, it } from 'vitest'
import { LAYOUT_STORAGE_KEY } from '../layout/storage'
import { createDemoWorkforce } from './demo'
import { addActivity, applyRuntimeEvent, assignTask, INTERRUPTED_MESSAGE, markStarting, removeAgent } from './operations'
import { loadWorkforce, migrateWorkforce, migrateWorkforceV1, migrateWorkforceV2, parseWorkforce, saveWorkforce, serializeWorkforce, WORKFORCE_BACKUP_KEY, WORKFORCE_STORAGE_KEY, WORKFORCE_V1_KEY, WORKFORCE_V2_KEY } from './storage'
import { REVIEW_MAX_BYTES, type WorkforceState } from './types'

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
    expect(new Set(s.touched)).toEqual(new Set([WORKFORCE_STORAGE_KEY, WORKFORCE_V2_KEY, WORKFORCE_V1_KEY]))
    expect(s.writes.every((k) => k === WORKFORCE_STORAGE_KEY)).toBe(true)
    expect(WORKFORCE_STORAGE_KEY).toBe('ai-virtual-office:workforce:v3')
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
    const json = JSON.stringify({ ...JSON.parse(serializeWorkforce(createDemoWorkforce(NOW))), schemaVersion: 4 })
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

  describe('task usage', () => {
    const finished = () => {
      const { state, taskId } = withRunningTask()
      return applyRuntimeEvent(state, { type: 'completed', taskId, summary: 'x', usage: { turns: 3, costUsd: 0.0123 } }, NOW, 'mock')
    }

    it('survives a round trip', () => {
      expect(roundTrip(finished())?.tasks[0].usage).toEqual({ turns: 3, costUsd: 0.0123 })
    })

    it('loads null for state saved without the field', () => {
      const raw = JSON.parse(serializeWorkforce(finished()))
      delete raw.tasks[0].usage
      expect(parseWorkforce(raw)?.tasks[0].usage).toBeNull()
    })

    it.each([
      ['a string', 'lots'],
      ['an array', [3, 0.1]],
      ['no cost', { turns: 1 }],
      ['string numbers', { turns: '1', costUsd: '0.1' }],
      ['negative cost', { turns: 1, costUsd: -0.01 }],
      ['negative turns', { turns: -1, costUsd: 0 }],
      ['fractional turns', { turns: 1.5, costUsd: 0 }],
      ['absurd turns', { turns: 1001, costUsd: 0 }],
      ['absurd cost', { turns: 1, costUsd: 1000.5 }],
      ['null cost (a serialized NaN)', { turns: 1, costUsd: null }],
      ['an extra key', { turns: 1, costUsd: 0, note: 'x' }],
    ])('rejects the whole state for %s', (_n, bad) => {
      const raw = JSON.parse(serializeWorkforce(finished()))
      raw.tasks[0].usage = bad
      expect(parseWorkforce(raw)).toBeNull()
    })

    it('accepts the upper bounds', () => {
      const raw = JSON.parse(serializeWorkforce(finished()))
      raw.tasks[0].usage = { turns: 1000, costUsd: 1000 }
      expect(parseWorkforce(raw)?.tasks[0].usage).toEqual({ turns: 1000, costUsd: 1000 })
    })
  })

  it('keeps onceOnly through a round trip and loads an approval saved without it as false', () => {
    const { state, taskId } = withRunningTask()
    const digest = 'cd'.repeat(32)
    const waiting = applyRuntimeEvent(state, { type: 'approval_requested', taskId, approvalId: 'a1', tool: 'Write', summary: 's', digest, onceOnly: true }, NOW, 'mock')
    expect(roundTrip(waiting)?.tasks[0].pendingApproval).toMatchObject({ id: 'a1', onceOnly: true })
    const raw = JSON.parse(JSON.stringify(waiting))
    delete raw.tasks[0].pendingApproval.onceOnly
    expect(parseWorkforce(raw)?.tasks[0].pendingApproval).toMatchObject({ id: 'a1', onceOnly: false })
  })

  it('keeps an approval digest through a round trip and loads an approval saved without one', () => {
    const { state, taskId } = withRunningTask()
    const digest = 'cd'.repeat(32)
    const waiting = applyRuntimeEvent(state, { type: 'approval_requested', taskId, approvalId: 'a1', tool: 'Write', summary: 's', digest }, NOW, 'mock')
    expect(roundTrip(waiting)?.tasks[0].pendingApproval).toMatchObject({ id: 'a1', digest })
    const raw = JSON.parse(serializeWorkforce(waiting))
    delete raw.tasks[0].pendingApproval.digest
    expect(parseWorkforce(raw)?.tasks[0].pendingApproval).toMatchObject({ id: 'a1', digest: null })
    raw.tasks[0].pendingApproval.digest = 'not-hex'
    expect(parseWorkforce(raw)).toBeNull()
  })

  describe('a pending review', () => {
    const digest = 'cd'.repeat(32)
    const review = { kind: 'write', path: 'a.txt', bytes: 3, lines: 1, content: 'abc', workspaceId: 'sandbox', digest }
    const waiting = () => {
      const { state, taskId } = withRunningTask()
      const ev = { type: 'approval_requested' as const, taskId, approvalId: 'a1', tool: 'Write', summary: 's', digest, review: review as never }
      return applyRuntimeEvent(state, ev, NOW, 'mock')
    }
    const withReview = (mutate: (r: any) => void) => { const raw = JSON.parse(serializeWorkforce(waiting())); mutate(raw.tasks[0].pendingApproval); return parseWorkforce(raw) }

    it('survives a round trip', () => {
      expect(roundTrip(waiting())?.tasks[0].pendingApproval?.review).toEqual(review)
    })

    it('an edit review round-trips', () => {
      const edit = { kind: 'edit', path: 'a.txt', bytes: 2, lines: 2, oldString: 'x', newString: 'y', replaceAll: true, workspaceId: 'sandbox', digest }
      expect(withReview((p) => { p.review = edit })?.tasks[0].pendingApproval?.review).toEqual(edit)
    })

    it('is rejected when its digest differs from the approval, its size is too big, or its shape is wrong', () => {
      expect(withReview((p) => { p.review.digest = 'ef'.repeat(32) })).toBeNull()
      expect(withReview((p) => { p.review.content = 'a'.repeat(REVIEW_MAX_BYTES + 1) })).toBeNull()
      expect(withReview((p) => { p.review.kind = 'delete' })).toBeNull()
      expect(withReview((p) => { delete p.review.content })).toBeNull()
      expect(withReview((p) => { p.digest = null })).toBeNull()
      expect(withReview((p) => { p.review.bytes = -1 })).toBeNull()
    })

    it('is null for an approval saved without one', () => {
      expect(withReview((p) => { delete p.review })?.tasks[0].pendingApproval?.review).toBeNull()
    })
  })

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
  forge.currentTaskId = 'task-done'; (forge as { status: string }).status = 'completed'
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
    const v2 = migrateWorkforceV1(JSON.parse(v1Json())) as any
    expect(v2.schemaVersion).toBe(2)
    const migrated = migrateWorkforce(JSON.parse(v1Json())) as any
    expect(migrated.schemaVersion).toBe(3)
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



const V2_AGENT = { id: 'a1', name: 'Nova', role: 'Planner', department: 'backend', deskId: null, status: 'completed', currentTaskId: 't1', runtimeMode: 'mock', demo: false, createdAt: NOW, lastActivityAt: NOW }
const V2_TASK = { id: 't1', agentId: 'a1', title: 'T', description: '', status: 'completed', createdAt: NOW, startedAt: NOW, completedAt: NOW, resultSummary: 'ok', errorMessage: null, executionId: null, timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: 'completed', usage: null, pendingApproval: null }
const V2_ACTIVITY = { id: 'x1', agentId: 'a1', taskId: 't1', type: 'task-completed', message: 'ok', timestamp: NOW, source: 'mock' }
const v2State = (agents: unknown[] = [V2_AGENT, { ...V2_AGENT, id: 'a2', status: 'error', currentTaskId: null }]) => ({ schemaVersion: 2, agents, tasks: [V2_TASK], activities: [V2_ACTIVITY] })
const PROFILE_DEFAULTS = { description: '', instructions: '', model: null, takesPrayerBreaks: true, sourceFile: null }

describe('migrateWorkforceV2', () => {
  it('returns schema 3 with the five defaults, completed becomes idle, error stays, tasks and activities unchanged', () => {
    const out = migrateWorkforceV2(v2State()) as { schemaVersion: number; agents: Record<string, unknown>[]; tasks: unknown[]; activities: unknown[] }
    expect(out.schemaVersion).toBe(3)
    expect(out.agents.map((a) => a.status)).toEqual(['idle', 'error'])
    for (const a of out.agents) expect(a).toMatchObject(PROFILE_DEFAULTS)
    expect(out.tasks).toEqual([V2_TASK])
    expect(out.activities).toEqual([V2_ACTIVITY])
    expect(parseWorkforce(out)).not.toBeNull()
  })

  it('passes through anything that is not a v2 object', () => {
    for (const v of [null, 'x', 5, [], { schemaVersion: 3, agents: [], tasks: [], activities: [] }, { schemaVersion: 1 }, { schemaVersion: 2 }, { schemaVersion: 2, agents: [], tasks: [] }]) expect(migrateWorkforceV2(v)).toBe(v)
  })

  it('migrateWorkforce runs v1 then v2', () => {
    const v1 = { schemaVersion: 1, agents: [{ ...V2_AGENT, status: 'idle' }], tasks: [{ id: 't1', agentId: 'a1', title: 'T', description: '', status: 'completed', createdAt: NOW, startedAt: NOW, completedAt: NOW, resultSummary: 'ok', errorMessage: null, executionId: null }], activities: [] }
    const out = parseWorkforce(migrateWorkforce(v1))
    expect(out?.schemaVersion).toBe(3)
    expect(out?.agents[0]).toMatchObject(PROFILE_DEFAULTS)
  })
})

describe('parseWorkforce agent profile', () => {
  const good = () => migrateWorkforceV2(v2State([{ ...V2_AGENT, status: 'idle' }])) as { agents: Record<string, unknown>[] }
  const withAgent = (patch: Record<string, unknown>) => { const s = good(); s.agents[0] = { ...s.agents[0], ...patch }; return s }
  it('accepts a full profile', () => {
    expect(parseWorkforce(withAgent({ description: 'd', instructions: 'i', model: 'claude-sonnet-4-5', takesPrayerBreaks: false, sourceFile: 'a.md' }))).not.toBeNull()
  })
  it.each([
    ['status completed', { status: 'completed' }],
    ['model with a leading dash', { model: '-x' }],
    ['model with a space', { model: 'a b' }],
    ['over-long instructions', { instructions: 'x'.repeat(8193) }],
    ['over-long description', { description: 'x'.repeat(501) }],
    ['non-boolean takesPrayerBreaks', { takesPrayerBreaks: 'yes' }],
    ['non-string instructions', { instructions: 5 }],
    ['non-string sourceFile', { sourceFile: 5 }],
  ])('rejects %s', (_n, patch) => { expect(parseWorkforce(withAgent(patch))).toBeNull() })
  it.each(['description', 'instructions', 'model', 'takesPrayerBreaks', 'sourceFile'])('rejects a missing %s', (key) => {
    const s = good()
    delete s.agents[0][key]
    expect(parseWorkforce(s)).toBeNull()
  })
  it('round-trips through serialize', () => {
    const r = createDemoWorkforce(NOW)
    expect(roundTrip(r)).toEqual(r)
    expect(JSON.parse(serializeWorkforce(r)).agents[0]).toMatchObject(PROFILE_DEFAULTS)
  })
})

describe('loadWorkforce v2 browser data', () => {
  it('migrates the v2 key in memory and never writes or removes it', () => {
    const s = memoryStorage({ 'ai-virtual-office:workforce:v2': JSON.stringify(v2State()) })
    const r = loadWorkforce(s, NOW)
    expect(r).toMatchObject({ seeded: false, migrated: true, problem: null })
    expect(r.state.agents.map((a) => a.status)).toEqual(['idle', 'error'])
    expect(s.writes).toEqual([])
    expect(WORKFORCE_STORAGE_KEY).toBe('ai-virtual-office:workforce:v3')
    expect(WORKFORCE_BACKUP_KEY).toBe('ai-virtual-office:workforce:v3:backup')
    expect(WORKFORCE_V2_KEY).toBe('ai-virtual-office:workforce:v2')
  })
  it('prefers v3 over v2', () => {
    const s = memoryStorage({ 'ai-virtual-office:workforce:v2': JSON.stringify(v2State()) })
    expect(saveWorkforce(s, createDemoWorkforce(NOW)).ok).toBe(true)
    const r = loadWorkforce(s, NOW)
    expect(r.migrated).toBe(false)
    expect(r.state.agents).toHaveLength(6)
  })
})
