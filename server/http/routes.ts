import { errorSentence } from '../errorCodes'
import type { ServerResponse } from 'node:http'
import pkg from '../../package.json' with { type: 'json' }
import type { AgentPermissionsRevokedResponse, PermissionResponse, PermissionsResponse, StateResponse, WorkspacesResponse } from '../../src/workforce/api'
import { restoreDemoAgents } from '../../src/workforce/demo'
import { assignDesk, createAgent, updateAgent } from '../../src/workforce/operations'
import type { ServerConfig } from '../config'
import type { AuditLog } from '../audit'
import type { Logger } from '../log'
import type { EventLog } from '../eventLog'
import { ruleState } from '../permissions/engine'
import type { PermissionStore } from '../permissions/store'
import type { GrantError } from '../permissions/types'
import { toRuleView } from '../permissions/view'
import type { ServerRuntimeProvider } from '../runtime/types'
import type { WorkforceStore } from '../store'
import type { ManagerError, TaskManager } from '../taskManager'
import { parseApproval, parseCreateAgent, parseCreatePermission, parseCreateTask, parseDesk, parsePatchAgent } from './inputs'
import { HttpError, type Reply, type Route } from './router'
import { eventsRoute } from './sse'

export type RouteDeps = {
  config: ServerConfig
  store: WorkforceStore
  events: EventLog
  provider: ServerRuntimeProvider
  manager: TaskManager
  permissions: PermissionStore
  now: () => string
  startedAt: string
  heartbeatMs: number
  streams: Set<ServerResponse>
  log: Logger
  maxStreams?: number
  audit: AuditLog
}

/** What a refused grant tells the person. The store's own `limit` is a conflict, the rest are 422. */
const GRANT_COPY: Record<GrantError, string> = {
  unknown_tool: 'Unknown tool.',
  invalid_scope: '"agentId" is only for an agent rule.',
  invalid_effect: '"effect" must be "allow", "deny" or "ask".',
  missing_agent: '"agentId" is required for an agent rule.',
  missing_task: 'Invalid permission.',
  missing_digest: 'Invalid permission.',
  scope_not_allowed_for_tool: 'That tool can only be allowed once, so it cannot be allowed for an agent or everyone.',
  invalid_pattern: '"pathPattern" must be a workspace-relative pattern such as src/**.',
  invalid_expiry: '"expiresAt" must be a date in the future.',
  invalid_reason: '"reason" is too long (200 characters at most).',
}

const HISTORY_LIMIT = 200

const STATUS: Record<ManagerError['code'], number> = { not_found: 404, invalid: 422, conflict: 409, unavailable: 503, bad_request: 400 }

/** A failed manager call becomes the HTTP error with its own message. */
function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) {
    const e = r as unknown as ManagerError
    throw new HttpError(STATUS[e.code], e.error)
  }
  return r as Extract<T, { ok: true }>
}

export function createRoutes(deps: RouteDeps): Route[] {
  const { config, store, events, provider, manager, permissions, now, startedAt } = deps
  const agent = (id: string) => store.state.agents.find((a) => a.id === id)

  const view = (rule: Parameters<typeof toRuleView>[0]) => toRuleView(rule, now())

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/health',
      handler: () => {
        const a = provider.availability
        return { status: 200, body: { ok: true, version: pkg.version, runtime: config.runtime, available: a.available, reason: a.available ? null : a.reason, credentialsConfigured: config.credentialsConfigured, persistence: { ok: store.saveError === null, error: store.saveError }, audit: deps.audit.status, startedAt } }
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      // The state and the last event id are read in the same tick, so a client can apply exactly the events after it.
      handler: () => {
        const body: StateResponse = { state: store.state, lastEventId: events.lastEventId, loadProblem: store.load.problem, preserved: store.load.preserved, saveError: store.saveError === null ? null : errorSentence(store.saveError) }
        return { status: 200, body }
      },
    },
    {
      method: 'GET',
      path: '/api/workspaces',
      // Ids only, so the task form can offer a choice; paths never leave the server.
      handler: () => {
        const body: WorkspacesResponse = { workspaces: config.workspaces.map(({ id }) => ({ id })) }
        return { status: 200, body }
      },
    },
    eventsRoute({ events, heartbeatMs: deps.heartbeatMs, streams: deps.streams, now, log: deps.log, maxStreams: deps.maxStreams }),
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
      handler: ({ params, requestId }) => {
        const r = must(manager.removeAgent(params.id, { requestId }))
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
      handler: ({ params, body, requestId }) => {
        const { workspaceId, ...input } = parseCreateTask(body as Record<string, unknown>)
        return { status: 202, body: { task: must(manager.startTask(params.id, input, { workspaceId, requestId })).task } }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/cancel',
      body: 'none',
      handler: ({ params, requestId }) => ({ status: 202, body: { task: must(manager.cancelTask(params.id, { requestId })).task } }),
    },
    {
      method: 'GET',
      path: '/api/permissions',
      handler: () => {
        const at = now()
        const body: PermissionsResponse = { rules: permissions.rules.filter((r) => ruleState(r, at) === 'active').map(view) }
        return { status: 200, body }
      },
    },
    {
      method: 'GET',
      path: '/api/permissions/history',
      // Rules that are no longer in force, newest first: revoked, expired, used up, or ended with their task.
      handler: () => {
        const at = now()
        const body: PermissionsResponse = { rules: permissions.rules.filter((r) => ruleState(r, at) !== 'active').reverse().slice(0, HISTORY_LIMIT).map(view) }
        return { status: 200, body }
      },
    },
    {
      method: 'POST',
      path: '/api/permissions',
      body: 'json',
      handler: ({ body }) => {
        const input = parseCreatePermission(body as Record<string, unknown>)
        if (input.scope === 'agent' && input.agentId !== null && !agent(input.agentId)) throw new HttpError(404, 'Agent not found.')
        const r = permissions.grant({ ...input, createdBy: 'user' })
        if (!r.ok) throw r.error === 'limit' ? new HttpError(409, 'Too many active permissions.') : new HttpError(422, GRANT_COPY[r.error])
        const reply: PermissionResponse = { rule: view(r.rule) }
        return { status: 201, body: reply }
      },
    },
    {
      method: 'DELETE',
      path: '/api/permissions/:id',
      handler: ({ params }) => {
        const reply: PermissionResponse = { rule: view(must(manager.revokePermission(params.id)).rule) }
        return { status: 200, body: reply }
      },
    },
    {
      method: 'DELETE',
      path: '/api/agents/:id/permissions',
      handler: ({ params }) => {
        const reply: AgentPermissionsRevokedResponse = { revoked: must(manager.revokeAgentPermissions(params.id)).revoked.map(view) }
        return { status: 200, body: reply }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/approval',
      body: 'json',
      handler: ({ params, body, requestId }) => {
        const { approvalId, decision, digest } = parseApproval(body as Record<string, unknown>)
        return { status: 200, body: { task: must(manager.decideApproval(params.id, approvalId, decision, { requestId }, digest)).task } }
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
