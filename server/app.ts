import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MOCK_TIMINGS } from '../src/workforce/runtime/mockRuntime'
import { resolveApiToken, type ApiToken } from './auth'
import { acquireDataDirLock } from './dataDirLock'
import { createSessionStore, type SessionStore } from './session'
import { openAuditLog, type AuditInput, type AuditLog } from './audit'
import type { ServerConfig } from './config'
import { deriveEvents } from './deriveEvents'
import { EventLog } from './eventLog'
import { createSecurityGuards, securityHeaders } from './http/guards'
import { createRoutes } from './http/routes'
import { createRouter, type Guard } from './http/router'
import { HEARTBEAT_MS } from './http/sse'
import { consoleLogger, type Logger } from './log'
import { redactingLogger } from './redact'
import { ClaudeAgentRuntimeProvider } from './runtime/claudeAgent'
import { ServerMockProvider } from './runtime/mockProvider'
import type { ServerRuntimeProvider } from './runtime/types'
import { openWorkforceStore, type WorkforceStore } from './store'
import { toRuleView } from './permissions/view'
import { openPermissionStore, type PermissionChange, type PermissionStore } from './permissions/store'
import { countUnboundWriteRules, UNBOUND_WRITE_RULES_WARNING } from './hostSafety'
import { TaskManager, type LifecycleEvent } from './taskManager'
import { toolPolicyFrom } from './toolPolicy'

export type AppDeps = {
  now?: () => string
  log?: Logger
  bootId?: string
  /** The default provider: replaces the registered provider of its kind, and its kind is the default runtime. */
  provider?: ServerRuntimeProvider
  /** Replace the provider of that kind (the claude one only where the Claude runtime is enabled). */
  mockProvider?: ServerRuntimeProvider
  claudeProvider?: ServerRuntimeProvider
  mockTimings?: typeof MOCK_TIMINGS
  heartbeatMs?: number
  maxStreams?: number
  audit?: AuditLog
  permissions?: PermissionStore
  /** Test seam: replaces the store's atomic file write. */
  storeWriteFile?: (path: string, text: string) => void
  guards?: Guard[]
  responseHeaders?: (req: IncomingMessage) => Record<string, string>
}

export type App = { config: ServerConfig; apiToken: ApiToken; sessions: SessionStore; store: WorkforceStore; permissions: PermissionStore; audit: AuditLog; events: EventLog; provider: ServerRuntimeProvider; manager: TaskManager; startedAt: string; streams: Set<ServerResponse>; handler: (req: IncomingMessage, res: ServerResponse) => void; closeStreams(): void; releaseLock(): void }

export type RunningServer = { url: string; port: number; app: App; close(): Promise<void> }

/** What the log says about a start: settings by name and ids only, never the workspace root, DATA_DIR or the key. */
export function startupRecord(config: ServerConfig, port: number, tokenSource: ApiToken['source']): AuditInput {
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(',') : 'none')
  return {
    action: 'config.startup',
    actor: 'system',
    detail: `runtime=${config.runtime} host=${config.host} port=${port} credentialsConfigured=${config.credentialsConfigured} workspaces=${list(config.workspaces.map((w) => w.id))} allowedTools=${list(config.allowedTools)} allowedOrigins=${list(config.allowedOrigins)} auth=${tokenSource}`,
  }
}

function toAuditInput(e: LifecycleEvent): AuditInput {
  const input: AuditInput = { action: e.action, actor: e.actor, agentId: e.agentId }
  if (e.taskId !== null) input.taskId = e.taskId
  for (const key of ['requestId', 'workspaceId', 'tool', 'decision', 'reason', 'digest', 'actionHash', 'ruleId', 'detail'] as const) if (e[key] !== undefined) input[key] = e[key]
  return input
}

/** Grants, revokes and expiry as audit records; a use or a refusal is audited where it happens, in the task manager. Task ends are not audited. */
function permissionAudit(change: PermissionChange): AuditInput | null {
  const { rule } = change
  const action = change.kind === 'granted' ? 'permission.granted' : change.kind === 'revoked' ? 'permission.revoked' : change.kind === 'expired' ? 'permission.expired' : null
  if (action === null) return null
  const input: AuditInput = { action, actor: change.kind === 'expired' || (change.kind === 'granted' && rule.createdBy !== 'user') ? 'system' : 'api', ruleId: rule.id, tool: rule.tool, reason: rule.scope, detail: rule.effect }
  if (rule.agentId !== null) input.agentId = rule.agentId
  if (rule.taskId !== null) input.taskId = rule.taskId
  return input
}

/** How often expired permissions are noticed for the audit log. Whether a rule applies is decided at each request, never by this timer. */
export const PERMISSION_SWEEP_MS = 30000

/** Wires the store, event log, provider, task manager and routes. Throws if the data file can't be read. */
export function createApp(config: ServerConfig, deps: AppDeps = {}): App {
  const log = redactingLogger(deps.log ?? consoleLogger)
  const now = deps.now ?? (() => new Date().toISOString())
  const events = new EventLog({ capacity: config.eventBufferSize, now, bootId: deps.bootId, log })
  // One server per DATA_DIR: taken before anything in the folder is opened or rewritten, released by close().
  const lock = acquireDataDirLock(config.dataDir)
  try {
    // Every commit, from any path, becomes typed events in the same tick, so state and log can't disagree.
    const store = openWorkforceStore({ dataDir: config.dataDir, now, log, writeFile: deps.storeWriteFile, onCommit: (before, after) => { events.append(deriveEvents(before, after)) } })
    // The store opens first: it creates DATA_DIR, where the audit log lives.
    const audit = deps.audit ?? openAuditLog({ dataDir: config.dataDir, maxBytes: config.auditLogMaxBytes, now, log, hide: config.workspaceRoot ? [config.workspaceRoot] : [] })
    const apiToken = resolveApiToken({ configured: config.apiToken?.reveal() ?? null, dataDir: config.dataDir })
    // The mock is always registered; the claude provider only when the owner asked for it. A task picks one; RUNTIME is the default.
    const claudeEnabled = config.runtime === 'claude' || config.enableClaudeRuntime
    const registered = new Map<ServerRuntimeProvider['kind'], ServerRuntimeProvider>()
    registered.set('mock', deps.mockProvider ?? new ServerMockProvider({ timings: deps.mockTimings }))
    if (claudeEnabled) registered.set('claude', deps.claudeProvider ?? new ClaudeAgentRuntimeProvider({ apiKey: config.anthropicApiKey, settings: config.claude, dataDir: config.dataDir, log, protectedRoots: toolPolicyFrom(config).protectedRoots, toolTimeoutMs: config.approvalTimeoutMs + 60000 }))
    if (deps.provider) registered.set(deps.provider.kind, deps.provider)
    const provider = deps.provider ?? registered.get(config.runtime)!
    const extraProviders = [...registered.values()].filter((p) => p !== provider)
    const permissions = deps.permissions ?? openPermissionStore({ dataDir: config.dataDir, now, log, onChange: (change) => { const record = permissionAudit(change); if (record) audit.write(record); events.appendPermission(change.kind, toRuleView(change.rule, now())) } })
    // Nothing is running yet at boot, so no task rule may survive from before: a task that was interrupted never ended its rules.
    // Rules of agents that no longer exist go too. Agent and global rules of existing agents are kept, as documented.
    for (const rule of permissions.reconcile({ liveTaskIds: new Set(), agentIds: new Set(store.state.agents.map((a) => a.id)) })) {
      if (rule.endedAt !== null && rule.revokedAt === null) audit.write({ action: 'permission.ended', actor: 'system', ruleId: rule.id, tool: rule.tool, reason: 'restart', detail: rule.scope, ...(rule.agentId !== null ? { agentId: rule.agentId } : {}), ...(rule.taskId !== null ? { taskId: rule.taskId } : {}) })
    }
    if (registered.has('claude')) {
      const unbound = countUnboundWriteRules(permissions.rules, now())
      if (unbound > 0) log.warn(UNBOUND_WRITE_RULES_WARNING(unbound))
    }
    const manager = new TaskManager({ store, provider, extraProviders, permissions, config, policy: toolPolicyFrom(config), now, log, onLifecycle: (e) => audit.write(toAuditInput(e)) })
    const streams = new Set<ServerResponse>()
    const startedAt = now()
    const sessions = createSessionStore({ now: () => Date.parse(now()) })
    const routes = createRoutes({ config, store, events, provider, manager, permissions, now, startedAt, heartbeatMs: deps.heartbeatMs ?? HEARTBEAT_MS, streams, log, maxStreams: deps.maxStreams, audit, sessions, apiToken: apiToken.value })
    const onReject = (r: { requestId: string; code: string; method: string; path: string }) => audit.write({ action: 'request.rejected', actor: 'api', requestId: r.requestId, reason: r.code, detail: `${r.method} ${r.path}` })
    const guards = [...createSecurityGuards({ allowedOrigins: config.allowedOrigins, apiToken: apiToken.value, sessions, onReject }), ...(deps.guards ?? [])]
    const responseHeaders = (req: IncomingMessage) => ({ ...securityHeaders(req, config.allowedOrigins), ...(deps.responseHeaders?.(req) ?? {}) })
    const handler = createRouter({ routes, guards, responseHeaders, log, onRejected: onReject })
    return {
        config, apiToken, sessions, store, permissions, audit, events, provider, manager, startedAt, streams, handler, releaseLock: lock.release,
      closeStreams: () => { for (const res of streams) res.end(); streams.clear() },
    }
  } catch (error) {
    lock.release()
    throw error
  }
}

export async function startServer(config: ServerConfig, deps: AppDeps = {}): Promise<RunningServer> {
  // Bind the port first: a second launch on a busy port must fail before it opens (and possibly rewrites) the data file.
  let handler: App['handler'] = (_req, res) => { res.writeHead(503).end() }
  const server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve() })
  })
  const stop = () => new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  })

  let app: App
  try {
    app = createApp(config, deps)
  } catch (error) {
    await stop()
    throw error
  }
  handler = app.handler
  const sweep = setInterval(() => app.permissions.sweep(), PERMISSION_SWEEP_MS)
  sweep.unref()
  const port = (server.address() as AddressInfo).port
  app.audit.write(startupRecord(config, port, app.apiToken.source))
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  return {
    url: `http://${host}:${port}`,
    port,
    app,
    close: async () => {
      clearInterval(sweep)
      app.closeStreams()
      await app.manager.dispose()
      await stop()
      app.audit.close()
      app.releaseLock()
    },
  }
}
