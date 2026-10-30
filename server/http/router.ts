import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../log'
import { readJsonBody } from './body'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** handled: the handler wrote the response itself (the event stream). */
export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { handled: true }

export type RequestContext = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: unknown }

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** path like '/api/agents/:id/desk'. body: 'json' reads and validates a JSON object; anything else never reads the body. */
export type Route = { method: Method; path: string; body?: 'json' | 'none'; handler: (ctx: RequestContext) => Reply | Promise<Reply> }

/** Runs before routing; a Reply short-circuits. This is where Stage C plugs in the origin allowlist and the JSON-only rule. */
export type Guard = (req: IncomingMessage, url: URL) => Reply | null

export type RouterOptions = { routes: Route[]; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string>; log: Logger }

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...BASE_HEADERS, 'content-length': String(Buffer.byteLength(text)), ...headers })
  res.end(text)
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/')
  const have = path.split('/')
  if (want.length !== have.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (have[i] === '') return null
      params[want[i].slice(1)] = decodeURIComponent(have[i])
    } else if (want[i] !== have[i]) return null
  }
  return params
}

export function createRouter({ routes, guards = [], responseHeaders, log }: RouterOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const reply = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    sendJson(res, status, body, { ...(responseHeaders?.(req) ?? {}), ...headers })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return reply(req, res, 400, { error: 'Invalid URL.' })
    }
    for (const guard of guards) {
      const blocked = guard(req, url)
      if (blocked) {
        if ('handled' in blocked) return
        return reply(req, res, blocked.status, blocked.body, blocked.headers)
      }
    }

    let route: Route | undefined
    let params: Record<string, string> = {}
    const allowed = new Set<string>()
    try {
      for (const candidate of routes) {
        const found = matchPath(candidate.path, url.pathname)
        if (!found) continue
        allowed.add(candidate.method)
        if (candidate.method === req.method && !route) { route = candidate; params = found }
      }
    } catch {
      return reply(req, res, 400, { error: 'Invalid URL.' })
    }
    if (!route) {
      if (allowed.size > 0) return reply(req, res, 405, { error: 'Method not allowed.' }, { allow: [...allowed].join(', ') })
      return reply(req, res, 404, { error: 'Not found.' })
    }

    const body = route.body === 'json' ? await readJsonBody(req) : undefined
    // A handler that writes its own response (the event stream) still gets the configured headers.
    for (const [name, value] of Object.entries(responseHeaders?.(req) ?? {})) res.setHeader(name, value)
    const result = await route.handler({ req, res, url, params, body })
    if ('handled' in result) return
    reply(req, res, result.status, result.body, result.headers)
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof HttpError) {
        // An oversized upload may still be streaming in; close the connection instead of draining it.
        return reply(req, res, error.status, { error: error.message }, error.status === 413 ? { connection: 'close' } : {})
      }
      log.error(`Unhandled error on ${req.method} ${req.url}`, error)
      reply(req, res, 500, { error: 'Internal server error.' })
    })
  }
}
