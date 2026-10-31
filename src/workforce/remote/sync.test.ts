import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeEvent, StateResponse } from '../api'
import { createDemoWorkforce } from '../demo'
import type { Agent, AgentTask } from '../types'
import { createApiClient, NOT_AUTHORIZED } from './client'
import { createFakeBackend, FakeEventSource } from './fakes'
import { createRemoteSync, reconnectDelay, type RemoteSync } from './sync'

const BASE = 'http://127.0.0.1:8787'
const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const stateAt = (lastEventId: string, state = demo): StateResponse => ({ state, lastEventId, loadProblem: null, preserved: null, saveError: null })
const flush = () => vi.advanceTimersByTimeAsync(0)
const calls = (b: { calls: { method: string; url: string }[] }, path: string) => b.calls.filter((c) => c.method === 'GET' && c.url === `${BASE}${path}`).length

const task = (id: string, agentId: string): AgentTask => ({ id, agentId, title: 'T', description: '', status: 'queued', createdAt: NOW, startedAt: null, completedAt: null, resultSummary: null, errorMessage: null, executionId: null, timeoutMs: null, runtime: 'mock', workspaceId: null, sessionId: null, endedReason: null, pendingApproval: null })
const change = (id: string, patch: Partial<ChangeEvent['patch']> = {}): ChangeEvent => ({ id, type: 'state.changed', at: NOW, agentId: null, taskId: null, patch: { agents: [], tasks: [], activities: [], removedAgentIds: [], ...patch } })
const reset = (id: string) => ({ id, type: 'state.reset' as const, at: NOW, reason: 'gap' as const })

let backend: ReturnType<typeof createFakeBackend>
let sync: RemoteSync
const es = (i: number) => FakeEventSource.instances[i]

function start(opts: { down?: boolean; lastEventId?: string; before?: (b: ReturnType<typeof createFakeBackend>) => void } = {}) {
  backend = createFakeBackend({ baseUrl: BASE, state: stateAt(opts.lastEventId ?? 'b1:5') })
  backend.down = opts.down ?? false
  opts.before?.(backend)
  sync = createRemoteSync({ client: createApiClient({ baseUrl: BASE, fetch: backend.fetch }), createEventSource: (url) => new FakeEventSource(url), now: () => NOW })
}

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset() })
afterEach(() => { sync?.dispose(); vi.useRealTimers() })

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

  it('shows Not authorized on a 401 and keeps retrying', async () => {
    start({ before: (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }) })
    await flush()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'offline', connectionError: NOT_AUTHORIZED })
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    await vi.advanceTimersByTimeAsync(1000)
    es(0).open()
    expect(sync.getSnapshot()).toMatchObject({ connection: 'live', connectionError: null })
  })

  it('opens the event stream on the same origin when the base URL is empty', async () => {
    backend = createFakeBackend({ baseUrl: '', state: stateAt('b1:5') })
    sync = createRemoteSync({ client: createApiClient({ baseUrl: '', fetch: backend.fetch }), createEventSource: (url) => new FakeEventSource(url), now: () => NOW })
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
