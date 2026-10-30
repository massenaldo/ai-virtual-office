import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MOCK_TIMINGS } from '../src/workforce/runtime/mockRuntime'
import type { ServerConfig } from './config'
import { deriveEvents } from './deriveEvents'
import { EventLog } from './eventLog'
import { createSecurityGuards, securityHeaders } from './http/guards'
import { createRoutes } from './http/routes'
import { createRouter, type Guard } from './http/router'
import { HEARTBEAT_MS } from './http/sse'
import { consoleLogger, type Logger } from './log'
import { ClaudeAgentRuntimeProvider } from './runtime/claudeAgent'
import { ServerMockProvider } from './runtime/mockProvider'
import type { ServerRuntimeProvider } from './runtime/types'
import { openWorkforceStore, type WorkforceStore } from './store'
import { TaskManager } from './taskManager'
import { toolPolicyFrom } from './toolPolicy'

export type AppDeps = {
  now?: () => string
  log?: Logger
  bootId?: string
  provider?: ServerRuntimeProvider
  mockTimings?: typeof MOCK_TIMINGS
  heartbeatMs?: number
  maxStreams?: number
  guards?: Guard[]
  responseHeaders?: (req: IncomingMessage) => Record<string, string>
}

export type App = { config: ServerConfig; store: WorkforceStore; events: EventLog; provider: ServerRuntimeProvider; manager: TaskManager; startedAt: string; streams: Set<ServerResponse>; handler: (req: IncomingMessage, res: ServerResponse) => void; closeStreams(): void }

export type RunningServer = { url: string; port: number; app: App; close(): Promise<void> }

/** Wires the store, event log, provider, task manager and routes. Throws if the data file can't be read. */
export function createApp(config: ServerConfig, deps: AppDeps = {}): App {
  const log = deps.log ?? consoleLogger
  const now = deps.now ?? (() => new Date().toISOString())
  const events = new EventLog({ capacity: config.eventBufferSize, now, bootId: deps.bootId, log })
  // Every commit, from any path, becomes typed events in the same tick, so state and log can't disagree.
  const store = openWorkforceStore({ dataDir: config.dataDir, now, log, onCommit: (before, after) => { events.append(deriveEvents(before, after)) } })
  const provider = deps.provider ?? (config.runtime === 'mock' ? new ServerMockProvider({ timings: deps.mockTimings }) : new ClaudeAgentRuntimeProvider())
  const manager = new TaskManager({ store, provider, config, policy: toolPolicyFrom(config), now, log })
  const streams = new Set<ServerResponse>()
  const startedAt = now()
  const routes = createRoutes({ config, store, events, provider, manager, now, startedAt, heartbeatMs: deps.heartbeatMs ?? HEARTBEAT_MS, streams, log, maxStreams: deps.maxStreams })
  const guards = [...createSecurityGuards({ allowedOrigins: config.allowedOrigins }), ...(deps.guards ?? [])]
  const responseHeaders = (req: IncomingMessage) => ({ ...securityHeaders(req, config.allowedOrigins), ...(deps.responseHeaders?.(req) ?? {}) })
  const handler = createRouter({ routes, guards, responseHeaders, log })
  return {
    config, store, events, provider, manager, startedAt, streams, handler,
    closeStreams: () => { for (const res of streams) res.end(); streams.clear() },
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
  const host = config.host.includes(':') ? `[${config.host}]` : config.host
  return {
    url: `http://${host}:${port}`,
    port,
    app,
    close: async () => {
      app.closeStreams()
      await app.manager.dispose()
      await stop()
    },
  }
}
