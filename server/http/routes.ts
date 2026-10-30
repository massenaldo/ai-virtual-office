import type { ServerResponse } from 'node:http'
import pkg from '../../package.json' with { type: 'json' }
import type { StateResponse } from '../../src/workforce/api'
import { restoreDemoAgents } from '../../src/workforce/demo'
import { assignDesk, createAgent, updateAgent } from '../../src/workforce/operations'
import type { ServerConfig } from '../config'
import type { EventLog } from '../eventLog'
import type { ServerRuntimeProvider } from '../runtime/types'
import type { WorkforceStore } from '../store'
import type { ManagerError, TaskManager } from '../taskManager'
import { parseApproval, parseCreateAgent, parseCreateTask, parseDesk, parsePatchAgent } from './inputs'
import { HttpError, type Reply, type Route } from './router'
import { eventsRoute } from './sse'

export type RouteDeps = {
  config: ServerConfig
  store: WorkforceStore
  events: EventLog
  provider: ServerRuntimeProvider
  manager: TaskManager
  now: () => string
  startedAt: string
  heartbeatMs: number
  streams: Set<ServerResponse>
}

const STATUS: Record<ManagerError['code'], number> = { not_found: 404, invalid: 422, conflict: 409, unavailable: 503 }

/** A failed manager call becomes the HTTP error with its own message. */
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) {
    const e = r as unknown as ManagerError
    throw new HttpError(STATUS[e.code], e.error)
  }
  return r as Extract<T, { ok: true }>
}

export function createRoutes(deps: RouteDeps): Route[] {
  const { config, store, events, provider, manager, now, startedAt } = deps
  const agent = (id: string) => store.state.agents.find((a) => a.id === id)

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/health',
      handler: () => {
        const a = provider.availability
        return { status: 200, body: { ok: true, version: pkg.version, runtime: config.runtime, available: a.available, reason: a.available ? null : a.reason, credentialsConfigured: config.credentialsConfigured, persistence: { ok: store.saveError === null, error: store.saveError }, startedAt } }
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      // The state and the last event id are read in the same tick, so a client can apply exactly the events after it.
      handler: () => {
        const body: StateResponse = { state: store.state, lastEventId: events.lastEventId, loadProblem: store.load.problem, preserved: store.load.preserved, saveError: store.saveError }
        return { status: 200, body }
      },
    },
    eventsRoute({ events, heartbeatMs: deps.heartbeatMs, streams: deps.streams, now }),
    {
      method: 'POST',
      path: '/api/agents',
      body: 'json',
      handler: ({ body }) => {
        const input = parseCreateAgent(body as Record<string, unknown>)
        const r = createAgent(store.state, input, now(), { runtimeMode: config.runtime === 'claude' ? 'real' : 'mock' })
        if (!r.ok) throw new HttpError(422, r.error)
        store.commit(r.state)
        return { status: 201, body: { agent: agent(r.id) } }
      },
    },
    {
      method: 'PATCH',
      path: '/api/agents/:id',
      body: 'json',
      handler: ({ params, body }) => {
        const patch = parsePatchAgent(body as Record<string, unknown>)
        const r = updateAgent(store.state, params.id, patch, now())
        if (!r.ok) throw new HttpError(r.error === 'Agent not found.' ? 404 : 422, r.error)
        store.commit(r.state)
        return { status: 200, body: { agent: agent(params.id) } }
      },
    },
    {
      method: 'DELETE',
      path: '/api/agents/:id',
      handler: ({ params }) => {
        const r = must(manager.removeAgent(params.id))
        return { status: 200, body: { ok: true, cancelledTaskId: r.cancelledTaskId } }
      },
    },
    {
      method: 'PUT',
      path: '/api/agents/:id/desk',
      body: 'json',
      handler: ({ params, body }) => {
        const { deskId } = parseDesk(body as Record<string, unknown>)
        const r = assignDesk(store.state, params.id, deskId, now())
        if (!r.ok) throw new HttpError(r.error === 'Agent not found.' ? 404 : 409, r.error)
        store.commit(r.state)
        return { status: 200, body: { agent: agent(params.id) } }
      },
    },
    {
      method: 'POST',
      path: '/api/agents/:id/tasks',
      body: 'json',
      handler: ({ params, body }) => {
        const input = parseCreateTask(body as Record<string, unknown>)
        return { status: 202, body: { task: must(manager.startTask(params.id, input)).task } }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/cancel',
      body: 'none',
      handler: ({ params }) => ({ status: 202, body: { task: must(manager.cancelTask(params.id)).task } }),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/approval',
      body: 'json',
      handler: ({ params, body }) => {
        const { approvalId, decision } = parseApproval(body as Record<string, unknown>)
        return { status: 200, body: { task: must(manager.decideApproval(params.id, approvalId, decision)).task } }
      },
    },
  ]

  // Demo controls exist only for the mock runtime; otherwise these paths are plain 404s.
  if (config.runtime === 'mock') {
    const ok = (): Reply => ({ status: 202, body: { ok: true } })
    routes.push(
      { method: 'POST', path: '/api/demo/tasks/:id/request-approval', body: 'none', handler: ({ params }) => { must(manager.requestApproval(params.id)); return ok() } },
      { method: 'POST', path: '/api/demo/tasks/:id/force-error', body: 'none', handler: ({ params }) => { must(manager.forceError(params.id)); return ok() } },
      { method: 'POST', path: '/api/demo/agents/restore', body: 'none', handler: () => { store.commit(restoreDemoAgents(store.state, now())); return { status: 200, body: { agents: store.state.agents } } } },
    )
  }
  return routes
}
