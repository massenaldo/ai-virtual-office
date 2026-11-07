import { errorSentence } from '../errorCodes'
import type { ServerResponse } from 'node:http'
import pkg from '../../package.json' with { type: 'json' }
import type { AgentFilePreview, AgentFilesResponse, AgentImportField, AgentPermissionsRevokedResponse, PermissionResponse, PermissionsResponse, StateResponse, WorkspacesResponse } from '../../src/workforce/api'
import type { LayoutResponse } from '../../src/layout/api'
import { parseLayout } from '../../src/layout/storage'
import { restoreDemoAgents } from '../../src/workforce/demo'
import { assignDesk, clearAgentError, createAgent, updateAgent } from '../../src/workforce/operations'
import type { ServerConfig } from '../config'
import { officeClockInfo } from '../officeClock'
import type { AuditLog } from '../audit'
import type { Logger } from '../log'
import type { EventLog } from '../eventLog'
import { ruleState } from '../permissions/engine'
import type { PermissionStore } from '../permissions/store'
import type { GrantError } from '../permissions/types'
import { toRuleView } from '../permissions/view'
import type { WorkforceStore } from '../store'
import type { LayoutStore } from '../layoutStore'
import { readJsonBody } from './body'
import type { ManagerError, TaskManager } from '../taskManager'
import { parseApproval, parseCreateAgent, parseCreatePermission, parseCreateTask, parseDesk, parseImportAgent, parsePatchAgent, parsePutLayout, parseReimportAgent } from './inputs'
import { listAgentFileNames, readAgentFile, readAgentFiles, type AgentFile } from '../agentImport/reader'
import { suggestedRole } from '../agentImport/parse'
import { resolveWorkspace, WORKSPACE_ID_RE } from '../workspaces'
import { HttpError, type Reply, type Route } from './router'
import { createSessionRoutes } from './sessionRoutes'
import type { SessionStore } from '../session'
import { eventsRoute } from './sse'

export type RouteDeps = {
  config: ServerConfig
  store: WorkforceStore
  layoutStore: LayoutStore
  events: EventLog
  manager: TaskManager
  permissions: PermissionStore
  now: () => string
  startedAt: string
  heartbeatMs: number
  streams: Set<ServerResponse>
  log: Logger
  maxStreams?: number
  audit: AuditLog
  sessions: SessionStore
  apiToken: string
  /** Real time in ms, for the office clock only. Test seam; defaults to Date.now. */
  officeNow?: () => number
  /** The real time the office clock started at; the app passes it so the manager and /api/state share one clock. */
  officeBootMs?: number
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

/** A layout is far larger than the 64 KB default body: rooms and furniture add up. */
export const MAX_LAYOUT_BODY_BYTES = 524288

const IMPORT_FIELDS: readonly AgentImportField[] = ['description', 'model', 'instructions']
/** The digest prefix and file name that identify what was imported; never the content. */
const DIGEST_PREFIX = 12

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
  const { config, store, layoutStore, events, manager, permissions, now, startedAt } = deps
  const agent = (id: string) => store.state.agents.find((a) => a.id === id)

  /** The workspace for this request, resolved afresh. One fixed sentence for every reason, so nothing about the server's folders leaks. */
  const workspaceOf = (id: unknown) => {
    const r = resolveWorkspace(config, id)
    if (!r.ok) throw new HttpError(404, 'Workspace not found.')
    return r.workspace
  }
  const sourceKey = (workspaceId: string, file: string) => `${workspaceId}:${file}`
  // Two names that differ only by case are one file on a case-insensitive disk, so they are one agent on every disk.
  const importedFrom = (key: string) => store.state.agents.find((a) => a.sourceFile !== null && a.sourceFile.toLowerCase() === key.toLowerCase())
  const changesFor = (a: NonNullable<ReturnType<typeof agent>>, f: Extract<AgentFile, { ok: true }>): AgentImportField[] => IMPORT_FIELDS.filter((k) => a[k] !== f.agent[k])
  /** The file as it is now, which must be the one the person confirmed: a changed, unreadable or failing file imports nothing. */
  const confirmedFile = (workspacePath: string, file: string, digest: string): Extract<AgentFile, { ok: true }> => {
    const fresh = readAgentFile(workspacePath, file, new AbortController().signal)
    if (!fresh) throw new HttpError(404, 'That agent file was not found.')
    // An empty digest means the read itself failed (a link, not text, not a regular file): say why, never "changed".
    if (fresh.digest === '') throw new HttpError(422, fresh.ok ? 'That agent file could not be read.' : fresh.error)
    if (fresh.digest !== digest) throw new HttpError(409, 'That agent file changed since you looked at it. Open the list again and review it.')
    if (!fresh.ok) throw new HttpError(422, fresh.error)
    return fresh
  }
  const auditImport = (action: 'agent.imported' | 'agent.reimported', requestId: string, workspaceId: string, agentId: string, file: string, digest: string) =>
    deps.audit.write({ action, actor: 'api', requestId, workspaceId, agentId, detail: `file=${file} digest=${digest.slice(0, DIGEST_PREFIX)}` })

  const officeNow = deps.officeNow ?? Date.now
  const officeBootMs = deps.officeBootMs ?? officeNow()

  const view = (rule: Parameters<typeof toRuleView>[0]) => toRuleView(rule, now())

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/health',
      handler: () => {
        // `runtime`, `available` and `reason` describe the default runtime, as before; `runtimes` lists every registered one.
        const runtimes = manager.runtimeStatuses()
        const d = runtimes.find((r) => r.kind === manager.defaultRuntime)!
        return { status: 200, body: { ok: true, version: pkg.version, runtime: d.kind, available: d.available, reason: d.reason, defaultRuntime: d.kind, runtimes, credentialsConfigured: config.credentialsConfigured, persistence: { ok: store.saveError === null, error: store.saveError }, audit: deps.audit.status, startedAt } }
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      // The state and the last event id are read in the same tick, so a client can apply exactly the events after it.
      handler: () => {
        const body: StateResponse = { state: store.state, lastEventId: events.lastEventId, loadProblem: store.load.problem, preserved: store.load.preserved, saveError: store.saveError === null ? null : errorSentence(store.saveError), office: officeClockInfo(config, officeNow, officeBootMs) }
        return { status: 200, body }
      },
    },
    {
      method: 'GET',
      path: '/api/layout',
      handler: () => {
        const body: LayoutResponse = { layout: layoutStore.layout, loadProblem: layoutStore.problem }
        return { status: 200, body }
      },
    },
    {
      method: 'PUT',
      path: '/api/layout',
      // Reads its own body: a layout may be larger than the default limit.
      handler: async ({ req }) => {
        const layout = parseLayout(parsePutLayout(await readJsonBody(req, MAX_LAYOUT_BODY_BYTES)))
        if (!layout) throw new HttpError(422, 'That is not a valid office layout.')
        const r = layoutStore.save(layout)
        if (!r.ok) throw new HttpError(500, errorSentence(r.error))
        return { status: 200, body: { ok: true } }
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
    ...createSessionRoutes({ sessions: deps.sessions, apiToken: deps.apiToken, audit: deps.audit, now }),
    eventsRoute({ events, heartbeatMs: deps.heartbeatMs, streams: deps.streams, now, log: deps.log, maxStreams: deps.maxStreams, sessions: deps.sessions, apiToken: deps.apiToken }),
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
      method: 'GET',
      path: '/api/workspaces/:id/agent-files',
      handler: ({ params }) => {
        const workspace = workspaceOf(params.id)
        const found = readAgentFiles(workspace.path, new AbortController().signal)
        const files = found.files.map((f): AgentFilePreview => {
          if (!f.ok) return f
          const existing = importedFrom(sourceKey(workspace.id, f.file))
          return { ...f, suggestedRole: suggestedRole(f.file), existing: existing ? { agentId: existing.id, changes: changesFor(existing, f) } : null }
        })
        const body: AgentFilesResponse = { folder: found.folder, cut: found.cut, files }
        return { status: 200, body }
      },
    },
    {
      method: 'POST',
      path: '/api/agents/import',
      body: 'json',
      handler: ({ body, requestId }) => {
        const input = parseImportAgent(body as Record<string, unknown>)
        const workspace = workspaceOf(input.workspaceId)
        // Exactly as the folder lists it: a differently cased name must not reach a case-insensitive disk.
        if (!listAgentFileNames(workspace.path)?.includes(input.file)) throw new HttpError(404, 'That agent file was not found.')
        const file = confirmedFile(workspace.path, input.file, input.digest)
        const key = sourceKey(workspace.id, input.file)
        const existing = importedFrom(key)
        if (existing) throw new HttpError(409, `That file is already imported as ${existing.name}. Use re-import to update it.`)
        const { name, description, instructions, model } = file.agent
        const r = createAgent(store.state, { name, role: input.role, department: input.department, description, instructions, model }, now(), { runtimeMode: config.runtime === 'claude' ? 'real' : 'mock', sourceFile: key })
        if (!r.ok) throw new HttpError(422, r.error)
        store.commit(r.state)
        auditImport('agent.imported', requestId, workspace.id, r.id, input.file, file.digest)
        return { status: 201, body: { agent: agent(r.id) } }
      },
    },
    {
      method: 'POST',
      path: '/api/agents/:id/reimport',
      body: 'json',
      handler: ({ params, body, requestId }) => {
        const { digest } = parseReimportAgent(body as Record<string, unknown>)
        const target = agent(params.id)
        if (!target) throw new HttpError(404, 'Agent not found.')
        if (target.sourceFile === null) throw new HttpError(409, 'This agent was not imported from a file.')
        const cut = target.sourceFile.indexOf(':')
        if (cut <= 0) throw new HttpError(404, 'Workspace not found.')
        const workspace = workspaceOf(target.sourceFile.slice(0, cut))
        // A case-only rename on disk keeps working: use the name as the folder lists it now.
        const stored = target.sourceFile.slice(cut + 1)
        const listed = listAgentFileNames(workspace.path) ?? []
        const fileName = listed.includes(stored) ? stored : listed.find((n) => n.toLowerCase() === stored.toLowerCase())
        if (fileName === undefined) throw new HttpError(404, 'That agent file was not found.')
        const file = confirmedFile(workspace.path, fileName, digest)
        const { description, model, instructions } = file.agent
        // Only these three: the name, role, department and desk belong to the person who edited them.
        const r = updateAgent(store.state, target.id, { description, model, instructions }, now())
        if (!r.ok) throw new HttpError(422, r.error)
        // A re-import that changes nothing is not an event worth recording.
        if (r.state !== store.state) {
          store.commit(r.state)
          auditImport('agent.reimported', requestId, workspace.id, target.id, fileName, file.digest)
        }
        return { status: 200, body: { agent: agent(target.id) } }
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
      method: 'POST',
      path: '/api/agents/:id/clear-error',
      body: 'none',
      handler: ({ params }) => {
        const r = clearAgentError(store.state, params.id, now())
        if (!r.ok) throw new HttpError(404, r.error)
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
        const { workspaceId, runtime, ...input } = parseCreateTask(body as Record<string, unknown>)
        return { status: 202, body: { task: must(manager.startTask(params.id, input, { workspaceId, runtime, requestId })).task } }
      },
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/cancel',
      body: 'none',
      handler: ({ params, requestId }) => ({ status: 202, body: { task: must(manager.cancelTask(params.id, { requestId })).task } }),
    },
    {
      method: 'POST',
      path: '/api/tasks/:id/start-now',
      body: 'none',
      handler: ({ params, requestId }) => ({ status: 202, body: { task: must(manager.startHeldTask(params.id, { requestId })).task } }),
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
        // The shape is checked before the lookup, so a malformed id never reaches the list of configured ones.
        if (input.workspaceId !== null && (!WORKSPACE_ID_RE.test(input.workspaceId) || !config.workspaces.some((w) => w.id === input.workspaceId))) throw new HttpError(422, 'Unknown workspace.')
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
