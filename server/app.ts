import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MOCK_TIMINGS } from '../src/workforce/runtime/mockRuntime'
import type { ServerConfig } from './config'
import { deriveEvents } from './deriveEvents'
import { EventLog } from './eventLog'
import { createRoutes } from './http/routes'
import { createRouter, type Guard } from './http/router'
import { HEARTBEAT_MS } from './http/sse'
import { consoleLogger, type Logger } from './log'
import { ClaudeAgentRuntimeProvider } from './runtime/claudeAgent'
import { ServerMockProvider } from './runtime/mockProvider'
import type { ServerRuntimeProvider } from './runtime/types'
import { openWorkforceStore, type WorkforceStore } from './store'
import { TaskManager } from './taskManager'

export type AppDeps = {
  now?: () => string
  log?: Logger
  bootId?: string
  provider?: ServerRuntimeProvider
  mockTimings?: typeof MOCK_TIMINGS
  heartbeatMs?: number
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
  const manager = new TaskManager({ store, provider, config, now, log })
  const streams = new Set<ServerResponse>()
  const startedAt = now()
  const routes = createRoutes({ config, store, events, provider, manager, now, startedAt, heartbeatMs: deps.heartbeatMs ?? HEARTBEAT_MS, streams })
  const handler = createRouter({ routes, guards: deps.guards, responseHeaders: deps.responseHeaders, log })
  return {
    config, store, events, provider, manager, startedAt, streams, handler,
    closeStreams: () => { for (const res of streams) res.end(); streams.clear() },
  }
}

export function startServer(config: ServerConfig, deps: AppDeps = {}): Promise<RunningServer> {
  let app: App
  try {
    app = createApp(config, deps)
  } catch (error) {
    return Promise.reject(error)
  }
  const server = createServer(app.handler)
  return new Promise((resolve, reject) => {
    server.once('error', (error) => { void app.manager.dispose(); reject(error) })
    server.listen(config.port, config.host, () => {
      const port = (server.address() as AddressInfo).port
      const host = config.host.includes(':') ? `[${config.host}]` : config.host
      resolve({
        url: `http://${host}:${port}`,
        port,
        app,
        close: async () => {
          app.closeStreams()
          await app.manager.dispose()
          await new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          })
        },
      })
    })
  })
}
