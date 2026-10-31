import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from './demo'
import { createFakeBackend, FakeEventSource } from './remote/fakes'
import { createControllerFor, resolveWorkforceSource } from './source'

const BASE = 'http://127.0.0.1:8787'
const stateResponse = { state: createDemoWorkforce('2026-10-31T09:00:00.000Z'), lastEventId: 'b1:1', loadProblem: null, preserved: null, saveError: null } as const

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset() })
afterEach(() => vi.useRealTimers())

describe('resolveWorkforceSource', () => {
  it('an empty or missing value selects the browser mock', () => {
    for (const raw of [undefined, '', '   ']) expect(resolveWorkforceSource(raw)).toEqual({ kind: 'browser' })
  })

  it('an http(s) origin selects the backend, without a trailing slash', () => {
    expect(resolveWorkforceSource('http://127.0.0.1:8787/')).toEqual({ kind: 'backend', baseUrl: BASE })
  })

  it('other values are invalid with a readable error', () => {
    for (const raw of ['nope', 'ftp://127.0.0.1:8787', 'http://127.0.0.1:8787/api', 'http://127.0.0.1:8787/?x=1'])
      expect(resolveWorkforceSource(raw)).toEqual({ kind: 'invalid', error: `VITE_WORKFORCE_API_URL must be an http(s) origin such as http://127.0.0.1:8787 (got "${raw}").` })
  })
})

describe('createControllerFor', () => {
  const noStorage = { getItem: vi.fn(() => null), setItem: vi.fn() }

  it('the browser source gives the local controller', () => {
    const c = createControllerFor({ kind: 'browser' }, { storage: null })
    expect(c.getSnapshot()).toMatchObject({ environment: { kind: 'browser' }, connection: 'local' })
    c.dispose()
  })

  it('the backend source never touches browser storage', async () => {
    const backend = createFakeBackend({ baseUrl: BASE, state: stateResponse })
    const c = createControllerFor({ kind: 'backend', baseUrl: BASE }, { storage: noStorage, fetch: backend.fetch, createEventSource: (u) => new FakeEventSource(u) })
    await vi.advanceTimersByTimeAsync(0)
    expect(c.getSnapshot().environment.kind).toBe('backend')
    expect(noStorage.getItem).not.toHaveBeenCalled()
    expect(noStorage.setItem).not.toHaveBeenCalled()
    c.dispose()
  })

  it('an invalid source gives a misconfigured controller, not the browser mock', () => {
    const c = createControllerFor({ kind: 'invalid', error: 'bad' }, { storage: null })
    expect(c.getSnapshot()).toMatchObject({ connection: 'misconfigured', state: { agents: [] } })
    c.dispose()
  })
})
