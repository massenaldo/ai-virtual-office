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

function make(state = stateAt('b1:5')) {
  backend = createFakeBackend({ baseUrl: BASE, state })
  c = createRemoteWorkforceController({ baseUrl: BASE, fetch: backend.fetch, createEventSource: (u) => new FakeEventSource(u), now: () => NOW })
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
})
