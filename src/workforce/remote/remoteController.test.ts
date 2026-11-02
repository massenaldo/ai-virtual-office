import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeEvent, StateResponse } from '../api'
import type { WorkforceController } from '../controller'
import { createDemoWorkforce } from '../demo'
import { createFakeBackend, FakeEventSource } from './fakes'
import { createRemoteWorkforceController } from './remoteController'

const BASE = 'http://127.0.0.1:8787'
const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const stateAt = (lastEventId: string, loadProblem: StateResponse['loadProblem'] = null): StateResponse => ({ state: demo, lastEventId, loadProblem, preserved: null, saveError: null })
const flush = () => vi.advanceTimersByTimeAsync(0)
const change = (id: string, agents = demo.agents.slice(0, 0)): ChangeEvent => ({ id, type: 'state.changed', at: NOW, agentId: null, taskId: null, patch: { agents, tasks: [], activities: [], removedAgentIds: [] } })
const newAgent = { ...demo.agents[0], id: 'a9', name: 'Older' }

let backend: ReturnType<typeof createFakeBackend>
let c: WorkforceController

function make(state = stateAt('b1:5'), before?: (b: ReturnType<typeof createFakeBackend>) => void, location?: { hostname: string; port: string }) {
  backend = createFakeBackend({ baseUrl: BASE, state })
  before?.(backend)
  c = createRemoteWorkforceController({ baseUrl: BASE, fetch: backend.fetch, createEventSource: (u, o) => new FakeEventSource(u, o), now: () => NOW, location })
}

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset() })
afterEach(() => { c?.dispose(); vi.useRealTimers() })

describe('createRemoteWorkforceController', () => {
  it('createAgent shows the agent before its event arrives', async () => {
    make()
    await flush()
    backend.respond('POST', '/api/agents', 201, { agent: newAgent })
    const r = await c.createAgent({ name: 'Older', role: 'R', department: 'design' })
    expect(r).toEqual({ ok: true, id: 'a9' })
    expect(c.getSnapshot().state.agents.some((a) => a.id === 'a9')).toBe(true)
  })

  it('createAgent never overwrites a newer agent from an event', async () => {
    make()
    await flush()
    backend.respond('POST', '/api/agents', 201, { agent: newAgent })
    const release = backend.hold('/api/agents')
    const pending = c.createAgent({ name: 'Older', role: 'R', department: 'design' })
    FakeEventSource.instances[0].emit(change('b1:6', [{ ...newAgent, name: 'Newer' }]))
    release()
    await pending
    expect(c.getSnapshot().state.agents.find((a) => a.id === 'a9')?.name).toBe('Newer')
  })

  it('void command errors show in commandError until dismissed', async () => {
    make()
    await flush()
    backend.respond('POST', '/api/demo/tasks/t1/force-error', 404, { error: 'Not found.' })
    c.forceError('t1')
    await flush()
    expect(c.getSnapshot().commandError).toBe('Not found.')
    c.dismissCommandError()
    expect(c.getSnapshot().commandError).toBeNull()
  })

  it('dismissLoadProblem keeps the notice hidden after a resync', async () => {
    make(stateAt('b1:5', 'corrupt'))
    await flush()
    expect(c.getSnapshot().loadProblem).toBe('corrupt')
    c.dismissLoadProblem()
    expect(c.getSnapshot().loadProblem).toBeNull()
    FakeEventSource.instances[0].emit({ id: 'b1:6', type: 'state.reset', at: NOW, reason: 'gap' })
    await flush()
    expect(c.getSnapshot().loadProblem).toBeNull()
  })

  it('returns the same snapshot object until something changes', async () => {
    make()
    await flush()
    const a = c.getSnapshot()
    expect(c.getSnapshot()).toBe(a)
  })

  it('with a config error it never connects and shows the error', async () => {
    const fetch = vi.fn()
    c = createRemoteWorkforceController({ baseUrl: '', fetch: fetch as unknown as typeof globalThis.fetch, configError: 'bad config' })
    await flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(c.getSnapshot()).toMatchObject({ connection: 'misconfigured', commandError: 'bad config', state: { agents: [] } })
    expect(await c.startTask('a1', { title: 'T', description: '' })).toEqual({ ok: false, error: 'bad config' })
  })

  it('dispose disposes the sync', async () => {
    make()
    await flush()
    c.dispose()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('pair posts the token, then reconnects and clears needsPairing', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }))
    await flush()
    expect(c.getSnapshot().needsPairing).toBe(true)
    backend.respond('POST', '/api/session', 200, { ok: true, expiresAt: NOW })
    backend.respond('GET', '/api/state', 200, stateAt('b1:5'))
    expect(await c.pair!('tok')).toEqual({ ok: true })
    await flush()
    expect(backend.calls.find((x) => x.url === `${BASE}/api/session`)?.body).toBe('{"token":"tok"}')
    expect(c.getSnapshot()).toMatchObject({ needsPairing: false, lastSyncedAt: NOW })
  })

  it('pair returns the server error and does not reconnect on failure', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }))
    await flush()
    backend.respond('POST', '/api/session', 401, { error: 'Unauthorized.' })
    expect(await c.pair!('bad')).toEqual({ ok: false, error: 'That token was not accepted.' })
    await flush()
    expect(c.getSnapshot().needsPairing).toBe(true)
    expect(backend.calls.filter((x) => x.method === 'GET' && x.url === `${BASE}/api/state`)).toHaveLength(1)
  })

  it('pair that succeeds but is followed by another 401 says the browser did not keep the session', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }))
    await flush()
    backend.respond('POST', '/api/session', 200, { ok: true, expiresAt: NOW })
    expect(await c.pair!('tok')).toEqual({ ok: false, error: 'Paired, but the browser did not keep the session. Open the app at the same address you started the backend with (127.0.0.1 or localhost).' })
    expect(c.getSnapshot().needsPairing).toBe(true)
  })

  it('pair that succeeds while the backend then fails (not 401) says it is not reachable yet', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }))
    await flush()
    backend.respond('POST', '/api/session', 200, { ok: true, expiresAt: NOW })
    backend.respond('GET', '/api/state', 500, { error: 'boom' })
    expect(await c.pair!('tok')).toEqual({ ok: false, error: 'Paired, but the backend is not reachable yet.' })
  })

  it('names both hosts when the page host differs from the backend host, never the token', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }), { hostname: 'localhost', port: '5173' })
    await flush()
    expect(c.getSnapshot().pairingNote).toBe('This page is open at localhost but the backend is at 127.0.0.1. Open the app at http://127.0.0.1:5173 so the browser keeps the session.')
  })

  it('has no pairing note when the hosts match, or the backend is the page origin', async () => {
    make(stateAt('b1:5'), (b) => b.respond('GET', '/api/state', 401, { error: 'Unauthorized.' }), { hostname: '127.0.0.1', port: '5173' })
    await flush()
    expect(c.getSnapshot().pairingNote).toBeNull()
    c.dispose()
    const same = createRemoteWorkforceController({ baseUrl: '', fetch: createFakeBackend({ baseUrl: '', state: stateAt('b1:5') }).fetch, createEventSource: (u, o) => new FakeEventSource(u, o), location: { hostname: 'localhost', port: '5173' } })
    expect(same.getSnapshot().pairingNote).toBeNull()
    same.dispose()
  })

  it('a 401 from a command makes the sync reconnect, so needsPairing is set at once', async () => {
    make()
    await flush()
    expect(c.getSnapshot().needsPairing).toBe(false)
    backend.respond('POST', '/api/agents', 401, { error: 'Unauthorized.' })
    backend.respond('GET', '/api/state', 401, { error: 'Unauthorized.' })
    expect(await c.createAgent({ name: 'X', role: 'R', department: 'design' })).toMatchObject({ ok: false })
    await flush()
    expect(c.getSnapshot().needsPairing).toBe(true)
  })

  it('a misconfigured controller fails pair with the config error and is never in needsPairing', async () => {
    const m = createRemoteWorkforceController({ baseUrl: '', configError: 'bad address' })
    expect(m.getSnapshot().needsPairing).toBe(false)
    expect(await m.pair!('t')).toEqual({ ok: false, error: 'bad address' })
    m.dispose()
  })
})
