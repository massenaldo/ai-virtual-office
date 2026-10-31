import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from '../demo'
import type { StateResponse } from '../api'
import { createApiClient } from './client'
import { createRemoteCommands, type RemoteCommands } from './commands'
import { createFakeBackend } from './fakes'

const BASE = 'http://127.0.0.1:8787'
const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const fakeState: StateResponse = { state: demo, lastEventId: 'b1:5', loadProblem: null, preserved: null, saveError: null }

let backend: ReturnType<typeof createFakeBackend>
let commands: RemoteCommands
const insertAgent = vi.fn()
const reportError = vi.fn()

beforeEach(() => {
  insertAgent.mockReset()
  reportError.mockReset()
  backend = createFakeBackend({ baseUrl: BASE, state: fakeState })
  backend.respond('POST', '/api/agents', 201, { agent: demo.agents[0] })
  commands = createRemoteCommands({ client: createApiClient({ baseUrl: BASE, fetch: backend.fetch }), insertAgent, reportError })
})

const ROUTES: Array<{ action: string; call: (c: RemoteCommands) => unknown; method: string; path: string; body?: string }> = [
  { action: 'createAgent', call: (c) => c.createAgent({ name: 'Nova', role: 'Planner', department: 'design' }), method: 'POST', path: '/api/agents', body: '{"name":"Nova","role":"Planner","department":"design"}' },
  { action: 'updateAgent', call: (c) => c.updateAgent('a 1', { name: 'N' }), method: 'PATCH', path: '/api/agents/a%201', body: '{"name":"N"}' },
  { action: 'removeAgent', call: (c) => c.removeAgent('a1'), method: 'DELETE', path: '/api/agents/a1' },
  { action: 'assignDesk', call: (c) => c.assignDesk('a1', 'desk-01'), method: 'PUT', path: '/api/agents/a1/desk', body: '{"deskId":"desk-01"}' },
  { action: 'assignDesk (clear)', call: (c) => c.assignDesk('a1', null), method: 'PUT', path: '/api/agents/a1/desk', body: '{"deskId":null}' },
  { action: 'startTask', call: (c) => c.startTask('a1', { title: 'T', description: 'D' }), method: 'POST', path: '/api/agents/a1/tasks', body: '{"title":"T","description":"D"}' },
  { action: 'cancelTask', call: (c) => c.cancelTask('t1'), method: 'POST', path: '/api/tasks/t1/cancel' },
  { action: 'decideApproval', call: (c) => c.decideApproval('t1', 'ap1', 'deny'), method: 'POST', path: '/api/tasks/t1/approval', body: '{"approvalId":"ap1","decision":"deny"}' },
  { action: 'decideApproval (with digest)', call: (c) => c.decideApproval('t1', 'ap1', 'approve', 'ef'.repeat(32)), method: 'POST', path: '/api/tasks/t1/approval', body: `{"approvalId":"ap1","decision":"approve","digest":"${'ef'.repeat(32)}"}` },
  { action: 'requestApproval', call: (c) => c.requestApproval('t1'), method: 'POST', path: '/api/demo/tasks/t1/request-approval' },
  { action: 'forceError', call: (c) => c.forceError('t1'), method: 'POST', path: '/api/demo/tasks/t1/force-error' },
  { action: 'restoreDemoAgents', call: (c) => c.restoreDemoAgents(), method: 'POST', path: '/api/demo/agents/restore' },
]

describe('createRemoteCommands', () => {
  it.each(ROUTES)('$action sends $method $path', async ({ call, method, path, body }) => {
    await call(commands)
    await vi.waitFor(() => expect(backend.calls.length).toBeGreaterThan(0))
    expect(backend.calls.at(-1)).toMatchObject({ method, url: `${BASE}${path}`, body })
    expect(backend.calls.at(-1)?.headers['content-type']).toBe('application/json')
  })

  it('createAgent returns the server id and inserts the returned agent', async () => {
    expect(await commands.createAgent({ name: 'Nova', role: 'Planner', department: 'design' })).toEqual({ ok: true, id: demo.agents[0].id })
    expect(insertAgent).toHaveBeenCalledWith(demo.agents[0])
  })

  it('startTask returns the server message for a 409', async () => {
    backend.respond('POST', '/api/agents/a1/tasks', 409, { error: 'Agent already has an active task.' })
    expect(await commands.startTask('a1', { title: 'T', description: '' })).toEqual({ ok: false, error: 'Agent already has an active task.' })
    expect(reportError).not.toHaveBeenCalledWith('Agent already has an active task.')
  })

  it('a failing void command reports its error and a success clears it', async () => {
    backend.respond('POST', '/api/demo/agents/restore', 404, { error: 'Not found.' })
    commands.restoreDemoAgents()
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith('Not found.'))
    commands.removeAgent('a1')
    await vi.waitFor(() => expect(reportError).toHaveBeenLastCalledWith(null))
  })
})
