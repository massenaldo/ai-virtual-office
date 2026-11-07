import { describe, expect, it } from 'vitest'
import type { ApiClient, ApiResult } from '../workforce/remote/client'
import type { LayoutResponse } from './api'
import { createDefaultLayout } from './defaultLayout'
import { updateFurniture } from './operations'
import { LAYOUT_STORAGE_KEY, serializeLayout } from './storage'
import { loadFromServer, saveToServer } from './serverLayout'

type Call = { method: string; path: string; body?: unknown }
function fakeApi(opts: { get?: ApiResult<unknown>; put?: ApiResult<unknown> }) {
  const calls: Call[] = []
  const api: ApiClient = {
    baseUrl: '',
    get: async (path) => { calls.push({ method: 'GET', path }); return (opts.get ?? { ok: true, status: 200, body: { layout: null, loadProblem: null } }) as never },
    send: async (method, path, body) => { calls.push({ method, path, body }); return (opts.put ?? { ok: true, status: 200, body: { ok: true } }) as never },
    pair: async () => { throw new Error('not used') },
  }
  return { api, calls }
}
const ok = (body: LayoutResponse): ApiResult<unknown> => ({ ok: true, status: 200, body })
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const writes: string[] = []
  return { data, writes, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); data.set(k, v) } }
}
const mine = () => updateFurniture(createDefaultLayout(), 'plant-01', { x: 5 })
const theirs = () => updateFurniture(createDefaultLayout(), 'plant-01', { x: -3 })

describe('loadFromServer', () => {
  it('uses the server layout and does not touch the browser copy', async () => {
    const { api, calls } = fakeApi({ get: ok({ layout: theirs(), loadProblem: null }) })
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(mine()) })
    const r = await loadFromServer(api, storage)
    expect(r).toEqual({ ok: true, layout: theirs(), savedJson: serializeLayout(theirs()), problem: null, saveError: null })
    expect(calls).toHaveLength(1)
    expect(storage.writes).toEqual([])
  })

  it('a server problem shows the default layout and never copies the browser layout over it', async () => {
    const { api, calls } = fakeApi({ get: ok({ layout: null, loadProblem: 'corrupt' }) })
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(mine()) })
    const r = await loadFromServer(api, storage)
    expect(r).toEqual({ ok: true, layout: createDefaultLayout(), savedJson: null, problem: 'corrupt', saveError: null })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
    const newer = await loadFromServer(fakeApi({ get: ok({ layout: null, loadProblem: 'unsupported-version' }) }).api, storage)
    expect(newer).toMatchObject({ ok: true, problem: 'unsupported-version', savedJson: null })
  })

  it('copies a valid browser layout to an empty server and leaves the browser copy alone', async () => {
    const { api, calls } = fakeApi({})
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(mine()) })
    const r = await loadFromServer(api, storage)
    expect(r).toEqual({ ok: true, layout: mine(), savedJson: serializeLayout(mine()), problem: null, saveError: null })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/layout', 'PUT /api/layout'])
    expect(calls[1].body).toEqual({ layout: mine() })
    expect(storage.writes).toEqual([])
    expect(storage.data.get(LAYOUT_STORAGE_KEY)).toBe(serializeLayout(mine()))
  })

  it('if copying fails, shows the browser layout as unsaved with the error', async () => {
    const { api } = fakeApi({ put: { ok: false, status: 500, error: 'Permission denied (EACCES).' } })
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(mine()) })
    expect(await loadFromServer(api, storage)).toEqual({ ok: true, layout: mine(), savedJson: null, problem: null, saveError: 'Permission denied (EACCES).' })
  })

  it.each([
    ['nothing', {}],
    ['a damaged copy', { [LAYOUT_STORAGE_KEY]: '{nope' }],
  ])('with %s in the browser, shows the default layout and writes nothing', async (_n, initial) => {
    const { api, calls } = fakeApi({})
    const storage = memoryStorage(initial)
    expect(await loadFromServer(api, storage)).toEqual({ ok: true, layout: createDefaultLayout(), savedJson: null, problem: null, saveError: null })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
    expect(storage.writes).toEqual([])
  })

  it('works without browser storage', async () => {
    expect(await loadFromServer(fakeApi({}).api, null)).toMatchObject({ ok: true, savedJson: null })
  })

  it('a failed GET is a failure with its status', async () => {
    const r = await loadFromServer(fakeApi({ get: { ok: false, status: 401, error: 'Not authorized.' } }).api, memoryStorage())
    expect(r).toEqual({ ok: false, status: 401, error: 'Not authorized.' })
    expect(await loadFromServer(fakeApi({ get: { ok: false, status: null, error: "Can't reach the backend." } }).api, memoryStorage())).toMatchObject({ ok: false, status: null })
  })

  it.each([['an invalid layout', { layout: { nope: 1 }, loadProblem: null }], ['no body', undefined], ['a bad shape', 'text']])('a 200 with %s is a failure, not a crash', async (_n, body) => {
    const r = await loadFromServer(fakeApi({ get: { ok: true, status: 200, body } }).api, memoryStorage())
    expect(r).toMatchObject({ ok: false, status: 200 })
  })

  it('passes the abort signal on', async () => {
    let seen: AbortSignal | undefined
    const api: ApiClient = { baseUrl: '', get: async (_p, signal) => { seen = signal; return { ok: false, status: null, error: 'x' } as never }, send: async () => { throw new Error('x') }, pair: async () => { throw new Error('x') } }
    const c = new AbortController()
    await loadFromServer(api, null, c.signal)
    expect(seen).toBe(c.signal)
  })
})

describe('saveToServer', () => {
  it('sends the layout and returns the serialised json', async () => {
    const { api, calls } = fakeApi({})
    expect(await saveToServer(api, mine())).toEqual({ ok: true, json: serializeLayout(mine()) })
    expect(calls).toEqual([{ method: 'PUT', path: '/api/layout', body: { layout: mine() } }])
  })
  it('returns the server error', async () => {
    expect(await saveToServer(fakeApi({ put: { ok: false, status: 500, error: 'No space left on the device (ENOSPC).' } }).api, mine())).toEqual({ ok: false, error: 'No space left on the device (ENOSPC).' })
  })
  it('does not send a layout that fails validation', async () => {
    const { api, calls } = fakeApi({})
    const bad = { ...createDefaultLayout(), rooms: [{ ...createDefaultLayout().rooms[0], width: -1 }] }
    expect(await saveToServer(api, bad)).toEqual({ ok: false, error: 'The layout failed validation and was not saved.' })
    expect(calls).toEqual([])
  })
})
