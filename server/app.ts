import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MOCK_TIMINGS } from '../src/workforce/runtime/mockRuntime'
import { resolveApiToken, type ApiToken } from './auth'
import { acquireDataDirLock } from './dataDirLock'
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
import { openPermissionStore, type PermissionStore } from './permissions/store'
import { TaskManager, type LifecycleEvent } from './taskManager'
import { toolPolicyFrom } from './toolPolicy'

export type AppDeps = {
  now?: () => string
  log?: Logger
  bootId?: string
  provider?: ServerRuntimeProvider
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

export type App = { config: ServerConfig; apiToken: ApiToken; store: WorkforceStore; permissions: PermissionStore; audit: AuditLog; events: EventLog; provider: ServerRuntimeProvider; manager: TaskManager; startedAt: string; streams: Set<ServerResponse>; handler: (req: IncomingMessage, res: ServerResponse) => void; closeStreams(): void; releaseLock(): void }

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
  for (const key of ['requestId', 'workspaceId', 'tool', 'decision', 'reason', 'detail'] as const) if (e[key] !== undefined) input[key] = e[key]
  return input
}

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
    const provider = deps.provider ?? (config.runtime === 'mock' ? new ServerMockProvider({ timings: deps.mockTimings }) : new ClaudeAgentRuntimeProvider({ credentialsConfigured: config.credentialsConfigured }))
    const permissions = deps.permissions ?? openPermissionStore({ dataDir: config.dataDir, now, log })
    const manager = new TaskManager({ store, provider, permissions, config, policy: toolPolicyFrom(config), now, log, onLifecycle: (e) => audit.write(toAuditInput(e)) })
    const streams = new Set<ServerResponse>()
    const startedAt = now()
    const routes = createRoutes({ config, store, events, provider, manager, now, startedAt, heartbeatMs: deps.heartbeatMs ?? HEARTBEAT_MS, streams, log, maxStreams: deps.maxStreams, audit })
    const onReject = (r: { requestId: string; code: string; method: string; path: string }) => audit.write({ action: 'request.rejected', actor: 'api', requestId: r.requestId, reason: r.code, detail: `${r.method} ${r.path}` })
    const guards = [...createSecurityGuards({ allowedOrigins: config.allowedOrigins, apiToken: apiToken.value, onReject }), ...(deps.guards ?? [])]
    const responseHeaders = (req: IncomingMessage) => ({ ...securityHeaders(req, config.allowedOrigins), ...(deps.responseHeaders?.(req) ?? {}) })
    const handler = createRouter({ routes, guards, responseHeaders, log, onRejected: onReject })
    return {
        config, apiToken, store, permissions, audit, events, provider, manager, startedAt, streams, handler, releaseLock: lock.release,
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
  const port = (server.address() as AddressInfo).port
  app.audit.write(startupRecord(config, port, app.apiToken.source))
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  return {
    url: `http://${host}:${port}`,
    port,
    app,
    close: async () => {
      app.closeStreams()
      await app.manager.dispose()
      await stop()
      app.audit.close()
      app.releaseLock()
    },
  }
}
