import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyPath } from '../../scripts/apiProxy'
import { consoleLogger, type Logger } from '../log'
import { createPasswordCheck } from './auth'
import { createApiProxy } from './proxy'
import { createStaticHandler } from './static'

// The public front door: password first for every request, then the built app, then the API proxy.

export type GatewayOptions = {
  password: string
  staticDir: string
  backend: { host: string; port: number }
  readToken(): string | null
  now?: () => number
  log?: Logger
}

const WWW_AUTHENTICATE = 'Basic realm="Virtual Office", charset="UTF-8"'

function sendJson(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(JSON.stringify({ error }))
}

export function createGateway(opts: GatewayOptions): { handler(req: IncomingMessage, res: ServerResponse): void; close(): void } {
  const log = opts.log ?? consoleLogger
  const passwords = createPasswordCheck({ password: opts.password, now: opts.now })
  const serveStatic = createStaticHandler({ root: opts.staticDir })
  const proxy = createApiProxy({ backend: opts.backend, readToken: opts.readToken, log })
  let locked = false

  return {
    handler(req, res) {
      res.setHeader('cache-control', 'no-store')
      const verdict = passwords.check(req.headers.authorization)
      if (!verdict.ok) {
        if (verdict.status === 429) {
          if (!locked) log.warn('Too many wrong passwords; refusing all attempts for a while.')
          locked = true
          return sendJson(res, 429, 'Too many attempts. Try again later.', { 'retry-after': String(verdict.retryAfterS ?? 300) })
        }
        return sendJson(res, 401, 'A password is required.', { 'www-authenticate': WWW_AUTHENTICATE })
      }
      locked = false
      const url = req.url ?? '/'
      // Anything that reads as the API, plain or not, goes to the proxy, which refuses the variants itself.
      if (classifyPath(url) !== 'other') return proxy(req, res)
      if (serveStatic(req, res)) return
      sendJson(res, 405, 'Method not allowed.', { allow: 'GET, HEAD' })
    },
    close() {},
  }
}

export async function startGateway(opts: GatewayOptions & { host: string; port: number }): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const gateway = createGateway(opts)
  const server = createServer(gateway.handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, resolve)
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${opts.host}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => {
      gateway.close()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
