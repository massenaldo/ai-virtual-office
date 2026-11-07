import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeEvent, PermissionChangedEvent, PermissionRuleView, StateResponse } from '../api'
import { createDemoWorkforce } from '../demo'
import type { Agent, AgentTask } from '../types'
import { createApiClient, NOT_AUTHORIZED } from './client'
import { createFakeBackend, FAKE_OFFICE, FakeEventSource } from './fakes'
import { createRemoteSync, reconnectDelay, type RemoteSync } from './sync'

const BASE = 'http://127.0.0.1:8787'
const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const stateAt = (lastEventId: string, state = demo): StateResponse => ({ state, lastEventId, loadProblem: null, preserved: null, saveError: null, office: FAKE_OFFICE })
const flush = () => vi.advanceTimersByTimeAsync(0)
const calls = (b: { calls: { method: string; url: string }[] }, path: string) => b.calls.filter((c) => c.method === 'GET' && c.url === `${BASE}${path}`).length

const task = (id: string, agentId: string): AgentTask => ({ id, agentId, title: 'T', description: '', status: 'queued', createdAt: NOW, startedAt: null, completedAt: null, resultSummary: null, errorMessage: null, executionId: null, timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: null, usage: null, pendingApproval: null, hold: null })
const change = (id: string, patch: Partial<ChangeEvent['patch']> = {}): ChangeEvent => ({ id, type: 'state.changed', at: NOW, agentId: null, taskId: null, patch: { agents: [], tasks: [], activities: [], removedAgentIds: [], ...patch } })
const reset = (id: string) => ({ id, type: 'state.reset' as const, at: NOW, reason: 'gap' as const })

let backend: ReturnType<typeof createFakeBackend>
let sync: RemoteSync
const es = (i: number) => FakeEventSource.instances[i]

function start(opts: { down?: boolean; lastEventId?: string; before?: (b: ReturnType<typeof createFakeBackend>) => void } = {}) {
  backend = createFakeBackend({ baseUrl: BASE, state: stateAt(opts.lastEventId ?? 'b1:5') })
  backend.down = opts.down ?? false
  opts.before?.(backend)
  sync = createRemoteSync({ client: createApiClient({ baseUrl: BASE, fetch: backend.fetch }), createEventSource: (url, o) => new FakeEventSource(url, o), now: () => NOW })
}

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset() })
afterEach(() => { sync?.dispose(); vi.useRealTimers() })

describe('createRemoteSync: office clock', () => {
  it('takes the office clock from the state reply', async () => {
    start({ before: (b) => b.setState({ ...stateAt('b1:5'), office: { nowMs: 1_700_000_000_000, speed: 60, routine: false } }) })
    await flush()
    expect(sync.getSnapshot().office).toEqual({ nowMs: 1_700_000_000_000, speed: 60, routine: false })
  })

  it('state from an older server with no office field still loads, on real time', async () => {
    const { office: _office, ...older } = stateAt('b1:5')
    start({ before: (b) => b.respond('GET', '/api/state', 200, older) })
    await flush()
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', office: null })
    expect(sync.getSnapshot().state.agents.length).toBeGreaterThan(0)
  })

  it.each([[null], ['x'], [{}], [{ nowMs: 'x', speed: 1, routine: true }], [{ nowMs: 1, speed: 0, routine: true }], [{ nowMs: 1, speed: 1 }]])('a malformed office %j does not break the sync', async (office) => {
    start({ before: (b) => b.respond('GET', '/api/state', 200, { ...stateAt('b1:5'), office }) })
    await flush()
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', office: null })
  })

  it('after a reconnect the clock comes from the fresh state', async () => {
    start()
    await flush()
    const first = sync.getSnapshot().office
    expect(first).toEqual(FAKE_OFFICE)
    backend.setState({ ...stateAt('b1:40'), office: { nowMs: FAKE_OFFICE.nowMs + 3_600_000, speed: 1, routine: true } })
    es(0).emit(reset('b1:6'))
    await flush()
    expect(sync.getSnapshot().office).toEqual({ nowMs: FAKE_OFFICE.nowMs + 3_600_000, speed: 1, routine: true })
    expect(sync.getSnapshot().office).not.toBe(first)
  })

  it('an older server after a newer one falls back to real time', async () => {
    start()
    await flush()
    const { office: _office, ...older } = stateAt('b1:40')
    backend.respond('GET', '/api/state', 200, older)
    es(0).emit(reset('b1:6'))
    await flush()
    expect(sync.getSnapshot().office).toBeNull()
  })
})

describe('createRemoteSync: workspaces', () => {
  it('is null until the backend answers, then holds the registered ids', async () => {
    start({ before: (b) => b.respond('GET', '/api/workspaces', 200, { workspaces: [{ id: 'sandbox' }, { id: 'docs' }] }) })
    expect(sync.getSnapshot().workspaces).toBeNull()
    await flush()
    expect(sync.getSnapshot().workspaces).toEqual(['sandbox', 'docs'])
  })
  it('falls back to no choice when the list fails or is malformed', async () => {
    start({ before: (b) => b.respond('GET', '/api/workspaces', 500, { error: 'No.' }) })
    await flush()
    expect(sync.getSnapshot().workspaces).toEqual([])
    sync.dispose()
    start({ before: (b) => b.respond('GET', '/api/workspaces', 200, { workspaces: [{ id: 1 }, 'x'] }) })
    await flush()
    expect(sync.getSnapshot().workspaces).toEqual([])
  })
})

describe('createRemoteSync: snapshot and stream', () => {
  it('starts connecting with an empty state', () => {
    start()
    expect(sync.getSnapshot()).toMatchObject({ state: { agents: [], tasks: [] }, connection: 'connecting', lastSyncedAt: null, environment: { kind: 'backend', runtime: null } })
  })

  it('loads the snapshot, then opens the stream at its lastEventId', async () => {
    start()
    await flush()
    expect(backend.calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/api/state` })
    expect(es(0).url).toBe(`${BASE}/api/events?lastEventId=b1%3A5`)
    expect(sync.getSnapshot().state).toEqual(demo)
    expect(sync.getSnapshot().connection).toBe('connecting')
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', lastSyncedAt: NOW })
  })

  it('reads the runtime from /api/health', async () => {
    start()
    await flush()
    expect(sync.getSnapshot().environment).toEqual({ kind: 'backend', runtime: 'mock', available: true, reason: null })
  })

  it('reads runtimes and the default runtime from /api/health when the server sends them', async () => {
    const runtimes = [{ kind: 'mock', available: true, reason: null }, { kind: 'claude', available: false, reason: 'Claude Agent SDK not installed' }]
    start({ before: (b) => b.respond('GET', '/api/health', 200, { ok: true, version: 'x', runtime: 'mock', available: true, reason: null, runtimes, defaultRuntime: 'mock', credentialsConfigured: false, startedAt: NOW }) })
    await flush()
    expect(sync.getSnapshot().environment).toEqual({ kind: 'backend', runtime: 'mock', available: true, reason: null, runtimes, defaultRuntime: 'mock' })
  })

  it('ignores malformed runtimes from /api/health', async () => {
    start({ before: (b) => b.respond('GET', '/api/health', 200, { ok: true, version: 'x', runtime: 'mock', available: true, reason: null, runtimes: [{ kind: 'bash', available: true }, 3], defaultRuntime: 'bash', credentialsConfigured: false, startedAt: NOW }) })
    await flush()
    expect(sync.getSnapshot().environment).toEqual({ kind: 'backend', runtime: 'mock', available: true, reason: null })
  })

  it('a failing /api/health does not block the connection', async () => {
    start({ before: (b) => b.respond('GET', '/api/health', 500, { error: 'boom' }) })
    await flush()
    expect(es(0)).toBeDefined()
    expect(sync.getSnapshot().environment).toMatchObject({ runtime: null })
  })

  it('applies change events in order', async () => {
    start()
    await flush()
    const agent = demo.agents[0]
    es(0).emit(change('b1:6', { tasks: [task('t-new', agent.id)] }))
    expect(sync.getSnapshot().state.tasks.map((t) => t.id)).toContain('t-new')
  })

  it('ignores an event that is not newer than the cursor', async () => {
    start()
    await flush()
    const listener = vi.fn()
    sync.subscribe(listener)
    es(0).emit(change('b1:6', { tasks: [task('t-new', demo.agents[0].id)] }))
    const after = sync.getSnapshot().state
    es(0).emit(change('b1:6', { tasks: [task('t-dup', demo.agents[0].id)] }))
    es(0).emit(change('b1:4', { tasks: [task('t-old', demo.agents[0].id)] }))
    expect(sync.getSnapshot().state).toBe(after)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('resyncs when an event comes from another boot', async () => {
    start()
    await flush()
    es(0).emit(change('b2:1'))
    await flush()
    expect(es(0).closed).toBe(true)
    expect(calls(backend, '/api/state')).toBe(2)
  })

  it('reloads the snapshot on state.reset', async () => {
    start()
    await flush()
    backend.setState(stateAt('b1:40'))
    es(0).emit(reset('b1:6'))
    await flush()
    expect(es(0).closed).toBe(true)
    expect(es(1).url).toBe(`${BASE}/api/events?lastEventId=b1%3A40`)
  })

  it('backs off after repeated resets', async () => {
    start()
    await flush()
    es(0).emit(reset('b1:6'))
    await flush()
    expect(calls(backend, '/api/state')).toBe(2)
    es(1).emit(reset('b1:7'))
    await vi.advanceTimersByTimeAsync(999)
    expect(calls(backend, '/api/state')).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls(backend, '/api/state')).toBe(3)
  })

  it('resyncs on a malformed event frame', async () => {
    start()
    await flush()
    es(0).emitRaw('task.progress', '{oops')
    await flush()
    expect(calls(backend, '/api/state')).toBe(2)
  })

  it('insertAgentIfAbsent adds a missing agent and leaves an existing one alone', async () => {
    start()
    await flush()
    const fresh: Agent = { ...demo.agents[0], id: 'agent-fresh', name: 'Fresh' }
    sync.insertAgentIfAbsent(fresh)
    expect(sync.getSnapshot().state.agents.find((a) => a.id === 'agent-fresh')?.name).toBe('Fresh')
    const before = sync.getSnapshot().state
    sync.insertAgentIfAbsent({ ...fresh, name: 'Other' })
    expect(sync.getSnapshot().state).toBe(before)
  })

  it('reconnectDelay doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })
})

describe('createRemoteSync: offline, restart and cleanup', () => {
  it('goes offline when the stream errors and keeps the last state', async () => {
    start()
    await flush()
    es(0).open()
    const before = sync.getSnapshot().state
    es(0).fail()
    expect(es(0).closed).toBe(true)
    expect(sync.getSnapshot()).toMatchObject({ connection: 'offline' })
    expect(sync.getSnapshot().state).toBe(before)
  })

  it('keeps the server message when the snapshot is refused, and clears it once live', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 403, { error: 'Origin not allowed.' }) })
    await flush()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'offline', connectionError: 'Origin not allowed.' })
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    await vi.advanceTimersByTimeAsync(1000)
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', connectionError: null })
  })

  it('reports an unreachable backend and an interrupted stream', async () => {
    start({ down: true })
    await flush()
    expect(sync.getSnapshot().connectionError).toBe("Can't reach the backend at http://127.0.0.1:8787.")
    backend.down = false
    await vi.advanceTimersByTimeAsync(1000)
    es(0).open()
    es(0).fail()
    expect(sync.getSnapshot().connectionError).toBe('The event stream was interrupted.')
  })

  it('opens the event stream with credentials', async () => {
    start()
    await flush()
    expect(es(0).opts).toEqual({ withCredentials: true })
  })

  it('a 401 on the snapshot sets needsPairing and stops: no backoff timer', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }) })
    await flush()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'offline', connectionError: NOT_AUTHORIZED, needsPairing: true })
    await vi.advanceTimersByTimeAsync(120000)
    expect(calls(backend, '/api/state')).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reconnect() after pairing loads the snapshot again and clears needsPairing', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }) })
    await flush()
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    sync.reconnect()
    await flush()
    expect(calls(backend, '/api/state')).toBe(2)
    expect(sync.getSnapshot().needsPairing).toBe(false)
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', connectionError: null, needsPairing: false })
  })

  it('a stream error followed by a 401 snapshot (session ended) sets needsPairing and stops', async () => {
    start()
    await flush()
    es(0).open()
    backend.respond('GET', '/api/state', 401, { error: 'Unauthorized.' })
    es(0).fail()
    expect(sync.getSnapshot().needsPairing).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sync.getSnapshot().needsPairing).toBe(true)
    await vi.advanceTimersByTimeAsync(120000)
    expect(calls(backend, '/api/state')).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed reconnect (still 401) stays in needsPairing without a timer', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }) })
    await flush()
    sync.reconnect()
    await flush()
    expect(sync.getSnapshot().needsPairing).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a 401 publishes the pairing note it was given, and a good snapshot clears it', async () => {
    backend = createFakeBackend({ baseUrl: BASE, state: stateAt('b1:5') })
    backend.respond('GET', '/api/state', 401, { error: 'Unauthorized.' })
    sync = createRemoteSync({ client: createApiClient({ baseUrl: BASE, fetch: backend.fetch }), createEventSource: (url, o) => new FakeEventSource(url, o), now: () => NOW, pairingNote: 'Use the other host.' })
    expect(sync.getSnapshot().pairingNote).toBeNull()
    await flush()
    expect(sync.getSnapshot()).toMatchObject({ needsPairing: true, pairingNote: 'Use the other host.' })
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    void sync.reconnect()
    await flush()
    expect(sync.getSnapshot().pairingNote).toBeNull()
  })

  it('reconnect() resolves to what the snapshot answered: ok, unauthorized or failed', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }) })
    await flush()
    expect(await sync.reconnect()).toBe('unauthorized')
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    expect(await sync.reconnect()).toBe('ok')
    backend.respond('GET', '/api/state', 500, { error: 'boom' })
    expect(await sync.reconnect()).toBe('failed')
  })

  it('other failures keep needsPairing false and retry', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 403, { error: 'Origin not allowed.' }) })
    await flush()
    expect(sync.getSnapshot().needsPairing).toBe(false)
  })

  it('opens the event stream on the same origin when the base URL is empty', async () => {
    backend = createFakeBackend({ baseUrl: '', state: stateAt('b1:5') })
    sync = createRemoteSync({ client: createApiClient({ baseUrl: '', fetch: backend.fetch }), createEventSource: (url, o) => new FakeEventSource(url, o), now: () => NOW })
    await flush()
    expect(es(0).url).toBe('/api/events?lastEventId=b1%3A5')
  })

  it('retries with backoff while the backend is down', async () => {
    start({ down: true })
    await flush()
    expect(calls(backend, '/api/state')).toBe(1)
    expect(sync.getSnapshot().connection).toBe('offline')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls(backend, '/api/state')).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls(backend, '/api/state')).toBe(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls(backend, '/api/state')).toBe(4)
  })

  it('resets the backoff after a stream opens', async () => {
    start({ down: true })
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls(backend, '/api/state')).toBe(2)
    backend.down = false
    await vi.advanceTimersByTimeAsync(2000)
    es(0).open()
    es(0).fail()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeEventSource.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('replaces state from the new snapshot after a server restart', async () => {
    start()
    await flush()
    es(0).open()
    es(0).fail()
    const restarted = { ...demo, tasks: [{ ...task('t-run', demo.agents[0].id), status: 'failed' as const, errorMessage: 'Interrupted by a server restart' }] }
    backend.setState(stateAt('b2:0', restarted))
    await vi.advanceTimersByTimeAsync(1000)
    expect(sync.getSnapshot().state).toEqual(restarted)
    expect(es(1).url).toBe(`${BASE}/api/events?lastEventId=b2%3A0`)
    es(1).emit(change('b1:6'))
    await flush()
    expect(calls(backend, '/api/state')).toBe(3)
    expect(sync.getSnapshot().state.tasks.map((t) => t.id)).not.toContain('t-late')
  })

  it('dispose closes the stream, cancels the retry and ignores late responses', async () => {
    start()
    const release = backend.hold('/api/state')
    const listener = vi.fn()
    sync.subscribe(listener)
    sync.dispose()
    release()
    await flush()
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()

    start()
    await flush()
    sync.dispose()
    expect(es(0).closed).toBe(true)

    FakeEventSource.reset()
    start({ down: true })
    await flush()
    const count = backend.calls.length
    sync.dispose()
    await vi.advanceTimersByTimeAsync(60000)
    expect(backend.calls.length).toBe(count)
  })
})

const prule = (id: string, over: Partial<PermissionRuleView> = {}): PermissionRuleView => ({ id, scope: 'global', effect: 'allow', tool: 'Read', agentId: null, taskId: null, pathPattern: null, createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active', ...over })
const pevent = (id: string, kind: PermissionChangedEvent['kind'], rule: PermissionRuleView): PermissionChangedEvent => ({ id, type: 'permission.changed', at: NOW, kind, rule })

describe('createRemoteSync: permissions', () => {
  it('loads the active rules and the history after the snapshot', async () => {
    start({ before: (b) => { b.respond('GET', '/api/permissions', 200, { rules: [prule('p1')] }); b.respond('GET', '/api/permissions/history', 200, { rules: [prule('p0', { state: 'revoked' })] }) } })
    expect(sync.getSnapshot().permissions).toEqual({ active: [], history: [], loaded: false, error: null })
    await flush()
    const p = sync.getSnapshot().permissions
    expect(p.loaded).toBe(true)
    expect(p.active.map((r) => r.id)).toEqual(['p1'])
    expect(p.history.map((r) => r.id)).toEqual(['p0'])
  })

  it('applies permission.changed from the stream without touching the workforce state', async () => {
    start()
    await flush()
    const before = sync.getSnapshot().state
    es(0).emit(pevent('b1:6', 'granted', prule('p9')))
    expect(sync.getSnapshot().permissions.active.map((r) => r.id)).toEqual(['p9'])
    expect(sync.getSnapshot().state).toBe(before)
    es(0).emit(pevent('b1:7', 'revoked', prule('p9', { state: 'revoked', revokedAt: NOW })))
    expect(sync.getSnapshot().permissions.active).toEqual([])
    expect(sync.getSnapshot().permissions.history.map((r) => r.id)).toEqual(['p9'])
  })

  it('an event that arrives while the lists load is not lost to an older list', async () => {
    start()
    const release = backend.hold('/api/permissions')
    await flush()
    es(0).emit(pevent('b1:6', 'granted', prule('p-new')))
    release()
    await flush()
    expect(sync.getSnapshot().permissions.active.map((r) => r.id)).toEqual(['p-new'])
    expect(sync.getSnapshot().permissions.loaded).toBe(true)
  })

  it('a replayed or older permission event is ignored like any other', async () => {
    start()
    await flush()
    es(0).emit(pevent('b1:6', 'granted', prule('p1')))
    es(0).emit(pevent('b1:6', 'revoked', prule('p1', { state: 'revoked' })))
    es(0).emit(pevent('b1:4', 'revoked', prule('p1', { state: 'revoked' })))
    expect(sync.getSnapshot().permissions.active.map((r) => r.id)).toEqual(['p1'])
  })

  it('a malformed event starts over from the snapshot', async () => {
    start()
    await flush()
    es(0).emitRaw('permission.changed', '{nope')
    await flush()
    expect(calls(backend, '/api/state')).toBe(2)
  })

  it('reloads both lists after a state.reset and after a reconnect', async () => {
    start()
    await flush()
    expect(calls(backend, '/api/permissions')).toBe(1)
    es(0).emit(reset('b1:6'))
    await flush()
    expect(calls(backend, '/api/permissions')).toBe(2)
    expect(calls(backend, '/api/permissions/history')).toBe(2)
    es(1).fail()
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls(backend, '/api/permissions')).toBe(3)
  })

  it('a failed list load keeps the old lists and says why once', async () => {
    start({ before: (b) => b.respond('GET', '/api/permissions', 200, { rules: [prule('p1')] }) })
    await flush()
    backend.respond('GET', '/api/permissions', 500, { error: 'No permissions today.' })
    es(0).emit(reset('b1:6'))
    await flush()
    const p = sync.getSnapshot().permissions
    expect(p.active.map((r) => r.id)).toEqual(['p1'])
    expect(p.error).toBe('No permissions today.')
  })

  it('a malformed list body is a failed load, not an empty list', async () => {
    start({ before: (b) => b.respond('GET', '/api/permissions', 200, { rules: [{ id: 1 }] }) })
    await flush()
    expect(sync.getSnapshot().permissions).toMatchObject({ loaded: false, active: [], error: 'The backend sent an invalid permission list.' })
  })

  it('a load that finishes after dispose or a newer connect changes nothing', async () => {
    start()
    const release = backend.hold('/api/permissions')
    await flush()
    sync.dispose()
    release()
    await flush()
    expect(sync.getSnapshot().permissions.loaded).toBe(false)
  })
})
