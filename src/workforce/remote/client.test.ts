import { beforeEach, describe, expect, it } from 'vitest'
import { createDemoWorkforce } from '../demo'
import type { StateResponse } from '../api'
import { createApiClient, NOT_AUTHORIZED, type ApiClient } from './client'
import { createFakeBackend } from './fakes'

const BASE = 'http://127.0.0.1:8787'
const fakeState: StateResponse = { state: createDemoWorkforce('2026-10-31T09:00:00.000Z'), lastEventId: 'b1:5', loadProblem: null, preserved: null, saveError: null }

let backend: ReturnType<typeof createFakeBackend>
let client: ApiClient

beforeEach(() => {
  backend = createFakeBackend({ baseUrl: BASE, state: fakeState })
  client = createApiClient({ baseUrl: BASE, fetch: backend.fetch })
})

describe('createApiClient', () => {
  it('GET carries no Content-Type and returns the JSON body', async () => {
    const r = await client.get<StateResponse>('/api/state')
    expect(r).toEqual({ ok: true, status: 200, body: fakeState })
    expect(backend.calls[0].headers['content-type']).toBeUndefined()
  })

  it('sends mutations with MUTATION_HEADERS and a JSON body', async () => {
    await client.send('PUT', '/api/agents/a1/desk', { deskId: 'desk-01' })
    expect(backend.calls[0]).toMatchObject({ method: 'PUT', url: `${BASE}/api/agents/a1/desk`, body: '{"deskId":"desk-01"}' })
    expect(backend.calls[0].headers['content-type']).toBe('application/json')
  })

  it('sends MUTATION_HEADERS on a body-less mutation', async () => {
    await client.send('POST', '/api/tasks/t1/cancel')
    expect(backend.calls[0].headers['content-type']).toBe('application/json')
    expect(backend.calls[0].body).toBeUndefined()
  })

  it('returns the server error message as-is', async () => {
    backend.respond('POST', '/api/agents', 403, { error: 'Origin not allowed.' })
    expect(await client.send('POST', '/api/agents', {})).toEqual({ ok: false, status: 403, error: 'Origin not allowed.' })
  })

  it('falls back to "Request failed (<status>)." for a non-JSON error body', async () => {
    backend.respond('POST', '/api/agents', 502, 'Bad gateway')
    expect(await client.send('POST', '/api/agents', {})).toEqual({ ok: false, status: 502, error: 'Request failed (502).' })
  })

  it("reports a network failure as Can't reach the backend", async () => {
    backend.down = true
    expect(await client.get('/api/state')).toEqual({ ok: false, status: null, error: "Can't reach the backend at http://127.0.0.1:8787." })
  })

  it('turns a 401 into the not-authorized message', async () => {
    backend.respond('GET', '/api/state', 401, { error: 'Unauthorized.' })
    expect(await client.get('/api/state')).toEqual({ ok: false, status: 401, error: NOT_AUTHORIZED })
    backend.respond('POST', '/api/agents', 401, { error: 'Unauthorized.' })
    expect(await client.send('POST', '/api/agents', {})).toEqual({ ok: false, status: 401, error: NOT_AUTHORIZED })
  })

  it('works against the same origin and says so when it cannot reach it', async () => {
    const same = createFakeBackend({ baseUrl: '', state: fakeState })
    const c = createApiClient({ baseUrl: '', fetch: same.fetch })
    expect(await c.get('/api/state')).toMatchObject({ ok: true })
    same.down = true
    expect(await c.get('/api/state')).toEqual({ ok: false, status: null, error: "Can't reach the backend." })
  })

  it('turns an abort into a failed result instead of throwing', async () => {
    const release = backend.hold('/api/state')
    const controller = new AbortController()
    const pending = client.get('/api/state', controller.signal)
    controller.abort()
    expect(await pending).toMatchObject({ ok: false, status: null })
    release()
  })
})
