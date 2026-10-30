import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import pkg from '../package.json' with { type: 'json' }
import type { ServerConfig } from './config'
import { createRouter, type Guard, type Route } from './http/router'
import { consoleLogger, type Logger } from './log'

/** Grows in later tasks (store, events, provider, manager). */
export type AppDeps = { now?: () => string; log?: Logger; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string> }

export type RunningServer = { url: string; port: number; close(): Promise<void> }

export function startServer(config: ServerConfig, deps: AppDeps = {}): Promise<RunningServer> {
  const log = deps.log ?? consoleLogger
  const available = config.runtime === 'mock'
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/api/health',
      handler: () => ({ status: 200, body: { ok: true, version: pkg.version, runtime: config.runtime, available, reason: available ? null : 'Claude Agent SDK not installed', credentialsConfigured: config.credentialsConfigured } }),
    },
  ]
  const server = createServer(createRouter({ routes, guards: deps.guards, responseHeaders: deps.responseHeaders, log }))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const port = (server.address() as AddressInfo).port
      const host = config.host.includes(':') ? `[${config.host}]` : config.host
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () => new Promise((done) => {
          server.close(() => done())
          server.closeAllConnections()
        }),
      })
    })
  })
}
