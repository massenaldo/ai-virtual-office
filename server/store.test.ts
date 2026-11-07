import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEMO_AGENTS, createDemoWorkforce } from '../src/workforce/demo'
import { applyRuntimeEvent, assignTask, createAgent, emptyWorkforce, HELD_RESTART_MESSAGE, markStarting } from '../src/workforce/operations'
import { parseWorkforce, serializeWorkforce } from '../src/workforce/storage'
import type { WorkforceState } from '../src/workforce/types'
import { silentLogger } from './log'
import { openWorkforceStore, WORKFORCE_BACKUP_FILE, WORKFORCE_FILE, type StoreOptions } from './store'

const NOW = '2026-10-31T09:00:00.000Z'
const now = () => NOW

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vo-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const file = () => join(dir, WORKFORCE_FILE)
const backup = () => join(dir, WORKFORCE_BACKUP_FILE)
const open = (extra: Partial<StoreOptions> = {}) => openWorkforceStore({ dataDir: dir, now, log: silentLogger, ...extra })
const onDisk = () => parseWorkforce(JSON.parse(readFileSync(file(), 'utf8')))

function withRunningTask(): WorkforceState {
  const r = assignTask(createDemoWorkforce(NOW), 'agent-demo-backend', { title: 'Build API', description: '' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return applyRuntimeEvent(markStarting(r.state, r.taskId, NOW), { type: 'started', taskId: r.taskId, executionId: 'exec-1' }, NOW, 'mock')
}

describe('openWorkforceStore: first start', () => {
  it('seeds the demo agents on first start and writes the file', () => {
    const store = open()
    expect(store.load).toMatchObject({ seeded: true, recovered: false, problem: null, preserved: null })
    expect(store.state.agents.map((a) => a.id)).toEqual(DEMO_AGENTS.map((a) => a.id))
    expect(onDisk()).toEqual(store.state)
    expect(store.filePath).toBe(file())
  })

  it('does not seed again when the file exists, even with no agents', () => {
    writeFileSync(file(), serializeWorkforce(emptyWorkforce()))
    const store = open()
    expect(store.load.seeded).toBe(false)
    expect(store.state.agents).toEqual([])
  })

  it('creates a missing nested DATA_DIR', () => {
    const nested = join(dir, 'a', 'b')
    openWorkforceStore({ dataDir: nested, now, log: silentLogger })
    expect(readdirSync(nested)).toEqual([WORKFORCE_FILE])
  })

  it('refuses to start when the file cannot be read', () => {
    mkdirSync(file())
    expect(() => open()).toThrow(/^Couldn't read .*workforce\.json: EISDIR/)
  })
})

describe('commit', () => {
  it('writes atomically and leaves no temp file', () => {
    const store = open()
    const r = createAgent(store.state, { name: 'Nova', role: 'Planner', department: 'design' }, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(store.commit(r.state)).toBe(true)
    expect(readdirSync(dir)).toEqual([WORKFORCE_FILE])
    expect(onDisk()?.agents.some((a) => a.name === 'Nova')).toBe(true)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(store.state).toBe(r.state)
  })

  it('does nothing for the same reference', () => {
    const writeFile = vi.fn()
    const onCommit = vi.fn()
    const store = open({ writeFile, onCommit })
    writeFile.mockClear()
    expect(store.commit(store.state)).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('calls onCommit synchronously with before and after', () => {
    const seen: Array<[WorkforceState, WorkforceState]> = []
    const store = open({ onCommit: (before, after) => seen.push([before, after]) })
    const before = store.state
    const r = createAgent(before, { name: 'Nova', role: 'Planner', department: 'design' }, NOW)
    if (!r.ok) throw new Error(r.error)
    store.commit(r.state)
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe(before)
    expect(seen[0][1]).toBe(r.state)
  })

  it('keeps working in memory when a write fails', () => {
    let fail = false
    const writeFile = vi.fn((path: string, text: string) => { if (fail) throw new Error('disk full'); writeFileSync(path, text) })
    const store = open({ writeFile })
    fail = true
    const a = createAgent(store.state, { name: 'Nova', role: 'Planner', department: 'design' }, NOW)
    if (!a.ok) throw new Error(a.error)
    expect(store.commit(a.state)).toBe(true)
    expect(store.state).toBe(a.state)
    expect(store.saveError).toBe('write_failed')
    fail = false
    const b = createAgent(store.state, { name: 'Quill', role: 'Writer', department: 'design' }, NOW)
    if (!b.ok) throw new Error(b.error)
    store.commit(b.state)
    expect(store.saveError).toBeNull()
  })

  it('logs a failed write once for each distinct message', () => {
    const errors: string[] = []
    const store = open({ writeFile: vi.fn(() => { throw new Error('disk full') }), log: { ...silentLogger, error: (m) => errors.push(m) } })
    for (const name of ['A', 'B', 'C']) {
      const r = createAgent(store.state, { name, role: 'R', department: 'design' }, NOW)
      if (!r.ok) throw new Error(r.error)
      store.commit(r.state)
    }
    expect(errors.filter((m) => m.includes('disk full'))).toHaveLength(1)
  })

  it('keeps only a safe error code, and the full message only in the server log', () => {
    const errors: string[] = []
    const seen: Array<string | null> = []
    const fail = (error: Error) => {
      const store = open({ writeFile: vi.fn(() => { throw error }), log: { ...silentLogger, error: (m) => errors.push(m) } })
      const r = createAgent(store.state, { name: 'Nova', role: 'R', department: 'design' }, NOW)
      if (!r.ok) throw new Error(r.error)
      store.commit(r.state)
      seen.push(store.saveError)
    }
    fail(Object.assign(new Error(`EACCES: permission denied, open '${dir}/workforce.json.tmp-1'`), { code: 'EACCES' }))
    fail(Object.assign(new Error(`weird at ${dir}`), { code: 'EWEIRD' }))
    fail(new Error(`no code at ${dir}`))
    expect(seen).toEqual(['EACCES', 'write_failed', 'write_failed'])
    expect(errors.some((m) => m.includes('EACCES: permission denied') && m.includes(dir))).toBe(true)
  })
})

describe('openWorkforceStore: existing data', () => {
  it('recovers interrupted tasks on load with the server message', () => {
    writeFileSync(file(), serializeWorkforce(withRunningTask()))
    const store = open()
    const task = store.state.tasks[0]
    expect(task).toMatchObject({ status: 'failed', errorMessage: 'Interrupted by a server restart', endedReason: 'failed' })
    expect(store.load.recovered).toBe(true)
    expect(onDisk()?.tasks[0].status).toBe('failed')
  })

  it('reopens a held task as failed with the restart sentence, and the agent shows the error', () => {
    const r = assignTask(createDemoWorkforce(NOW), 'agent-demo-backend', { title: 'Build API', description: '' }, NOW, { hold: { label: 'On lunch', untilMs: 1_000_000, blockedBy: null } })
    if (!r.ok) throw new Error(r.error)
    writeFileSync(file(), serializeWorkforce(r.state))
    const store = open()
    expect(store.state.tasks[0]).toMatchObject({ status: 'failed', errorMessage: HELD_RESTART_MESSAGE, hold: null })
    expect(store.state.agents.find((a) => a.id === 'agent-demo-backend')?.status).toBe('error')
    expect(store.load.recovered).toBe(true)
    expect(onDisk()?.tasks[0].status).toBe('failed')
  })

  it('does not rewrite the file when nothing needed recovering', () => {
    writeFileSync(file(), serializeWorkforce(createDemoWorkforce(NOW)))
    const writeFile = vi.fn()
    const store = open({ writeFile })
    expect(store.load.recovered).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('backs up a corrupt file once and starts empty', () => {
    writeFileSync(file(), '{not json')
    const first = open()
    expect(first.load).toMatchObject({ problem: 'corrupt', preserved: 'backup-created', seeded: false })
    expect(readFileSync(backup(), 'utf8')).toBe('{not json')
    expect(first.state.agents).toEqual([])
    expect(readFileSync(file(), 'utf8')).toBe('{not json')
    expect(open().load.preserved).toBe('backup-created')
    writeFileSync(file(), '{other garbage')
    expect(open().load).toMatchObject({ problem: 'corrupt', preserved: 'backup-exists' })
    expect(readFileSync(backup(), 'utf8')).toBe('{not json')
  })

  it('reports a newer schema as unsupported-version', () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 4, agents: [], tasks: [], activities: [] }))
    expect(open().load).toMatchObject({ problem: 'unsupported-version', preserved: 'backup-created' })
  })

  it('treats a file that parses but breaks a reference as corrupt', () => {
    const broken = JSON.parse(serializeWorkforce(createDemoWorkforce(NOW)))
    broken.agents[1].deskId = broken.agents[0].deskId
    writeFileSync(file(), JSON.stringify(broken))
    expect(open().load.problem).toBe('corrupt')
  })
})

describe('v2 to v3 migration on disk', () => {
  const v2Path = () => join(dir, 'workforce.v2-backup.json')
  const agent = (id: string, status: string) => ({ id, name: id, role: 'R', department: 'backend', deskId: null, status, currentTaskId: null, runtimeMode: 'mock', demo: false, createdAt: NOW, lastActivityAt: null })
  const task = (id: string, agentId: string, status: string, done: boolean) => ({ id, agentId, title: id, description: '', status, createdAt: NOW, startedAt: NOW, completedAt: done ? NOW : null, resultSummary: done ? 'ok' : null, errorMessage: null, executionId: 'e', timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: done ? 'completed' : null, usage: null, pendingApproval: null })
  const activity = { id: 'act-1', agentId: 'a1', taskId: 't-done', type: 'task-completed', message: 'ok', timestamp: NOW, source: 'mock' }
  const v2Text = () => JSON.stringify({ schemaVersion: 2, agents: [{ ...agent('a1', 'completed'), currentTaskId: 't-done' }, { ...agent('a2', 'working'), currentTaskId: 't-run' }], tasks: [task('t-done', 'a1', 'completed', true), task('t-run', 'a2', 'running', false)], activities: [activity] }, null, 1)

  it('keeps agents, tasks and activities, recovers the running task, rewrites as schema 3 and keeps the original text', () => {
    const text = v2Text()
    writeFileSync(file(), text)
    const logs: string[] = []
    const store = open({ log: { ...silentLogger, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } })
    expect(store.load).toMatchObject({ problem: null, seeded: false, recovered: true })
    expect(store.state.agents.map((a) => [a.id, a.status])).toEqual([['a1', 'idle'], ['a2', 'error']])
    expect(store.state.tasks.map((t) => [t.id, t.status])).toEqual([['t-done', 'completed'], ['t-run', 'failed']])
    expect(store.state.tasks[0].resultSummary).toBe('ok')
    expect(store.state.activities.some((x) => x.id === 'act-1')).toBe(true)
    const disk = onDisk()!
    expect(JSON.parse(readFileSync(file(), 'utf8')).schemaVersion).toBe(3)
    expect(disk.agents).toHaveLength(2)
    expect(disk.tasks.map((t) => t.status)).toEqual(['completed', 'failed'])
    expect(disk.activities.some((x) => x.id === 'act-1')).toBe(true)
    expect(disk.agents[0]).toMatchObject({ description: '', instructions: '', model: null, takesPrayerBreaks: true, sourceFile: null })
    expect(readFileSync(v2Path(), 'utf8')).toBe(text)
    expect(logs.filter((l) => l.includes('was migrated') && l.includes('The original is kept at'))).toHaveLength(1)
  })

  it('does not claim success when the save fails, and leaves the v2 file as it was', () => {
    const text = v2Text()
    writeFileSync(file(), text)
    const logs: string[] = []
    const store = open({
      log: { ...silentLogger, info: (m: string) => logs.push(`info ${m}`), error: (m: string) => logs.push(`error ${m}`) },
      writeFile: (path, t) => { if (path === file()) throw new Error('disk full'); writeFileSync(path, t) },
    })
    expect(store.saveError).not.toBeNull()
    expect(logs.some((l) => l.startsWith('error'))).toBe(true)
    expect(logs.some((l) => l.includes('was migrated'))).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(text)
    expect(readFileSync(v2Path(), 'utf8')).toBe(text)
  })

  it('says the existing backup was kept, not that the original is kept there', () => {
    writeFileSync(v2Path(), 'older')
    writeFileSync(file(), v2Text())
    const logs: string[] = []
    open({ log: { ...silentLogger, info: (m: string) => logs.push(m) } })
    const line = logs.find((l) => l.includes('was migrated'))!
    expect(line).toContain('already existed')
    expect(line).not.toContain('The original is kept at')
  })

  it('refuses to start when the existing backup is unreadable, and replaces nothing', () => {
    mkdirSync(v2Path())
    const text = v2Text()
    writeFileSync(file(), text)
    expect(() => open()).toThrow(/Migration to schema 3 did not run: couldn't read the existing backup .*EISDIR.*workforce\.json is unchanged/)
    expect(readFileSync(file(), 'utf8')).toBe(text)
    expect(statSync(v2Path()).isDirectory()).toBe(true)
  })

  it('refuses to start with a clear message when the backup cannot be written', () => {
    const text = v2Text()
    writeFileSync(file(), text)
    expect(() => open({ writeFile: (path, t) => { if (path === v2Path()) throw new Error('nope'); writeFileSync(path, t) } })).toThrow(/Migration to schema 3 did not run: couldn't write the backup .*workforce\.json is unchanged/)
    expect(readFileSync(file(), 'utf8')).toBe(text)
  })

  it('does not overwrite the backup on a second load', () => {
    const text = v2Text()
    writeFileSync(file(), text)
    open()
    open()
    expect(readFileSync(v2Path(), 'utf8')).toBe(text)
  })

  it('does not replace an existing backup with a different v2 file', () => {
    writeFileSync(v2Path(), 'older')
    writeFileSync(file(), v2Text())
    open()
    expect(readFileSync(v2Path(), 'utf8')).toBe('older')
  })

  it('still treats schema 4 as unsupported-version', () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 4, agents: [], tasks: [], activities: [] }))
    expect(open().load).toMatchObject({ problem: 'unsupported-version', preserved: 'backup-created' })
  })
})
