import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../log'
import { readJsonBody } from './body'

/** Why a request was refused before it reached a handler, for the audit log. A reason code only, never request content. */
export type RejectCode = 'host' | 'origin' | 'auth' | 'content_type' | 'body_too_large' | 'unknown_field' | 'stream_limit'

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: RejectCode) {
    super(message)
  }
}

/** handled: the handler wrote the response itself (the event stream). */
export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { handled: true }

export type RequestContext = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: unknown; requestId: string }

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** path like '/api/agents/:id/desk'. body: 'json' reads and validates a JSON object; anything else never reads the body. */
export type Route = { method: Method; path: string; body?: 'json' | 'none'; handler: (ctx: RequestContext) => Reply | Promise<Reply> }

/** Runs before routing; a Reply short-circuits. The security guards (Host, Origin, JSON-only) are Guards. */
export type Guard = (req: IncomingMessage, url: URL, info: { requestId: string }) => Reply | null

/** path is the URL path cut to 128 characters, without the query. */
export type RejectInfo = { status: number; code: RejectCode; method: string; path: string; requestId: string }

export type RouterOptions = { routes: Route[]; guards?: Guard[]; responseHeaders?: (req: IncomingMessage) => Record<string, string>; log: Logger; onRejected?: (r: RejectInfo) => void; newRequestId?: () => string }

/** 12 lowercase hex characters, made here: a request id is never taken from the client. */
export const newRequestId = (): string => randomBytes(6).toString('hex')

const BASE_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
    res.end()
    return
  }
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

const pathOf = (req: IncomingMessage): string => {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname.slice(0, 128)
  } catch {
    return '(invalid url)'
  }
}

export function createRouter({ routes, guards = [], responseHeaders, log, onRejected, newRequestId: makeId = newRequestId }: RouterOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const replyWith = (req: IncomingMessage, res: ServerResponse, requestId: string) => (status: number, body: unknown, headers: Record<string, string> = {}) =>
    sendJson(res, status, body, { ...(responseHeaders?.(req) ?? {}), 'x-request-id': requestId, ...headers })

  async function handle(req: IncomingMessage, res: ServerResponse, requestId: string, reply: ReturnType<typeof replyWith>): Promise<void> {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return reply(400, { error: 'Invalid URL.' })
    }
    for (const guard of guards) {
      const blocked = guard(req, url, { requestId })
      if (blocked) {
        if ('handled' in blocked) return
        return reply(blocked.status, blocked.body, blocked.headers)
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
      return reply(400, { error: 'Invalid URL.' })
    }
    if (!route) {
      if (allowed.size > 0) return reply(405, { error: 'Method not allowed.' }, { allow: [...allowed].join(', ') })
      return reply(404, { error: 'Not found.' })
    }

    const body = route.body === 'json' ? await readJsonBody(req) : undefined
    // A handler that writes its own response (the event stream) still gets the configured headers and the request id.
    for (const [name, value] of Object.entries({ ...(responseHeaders?.(req) ?? {}), 'x-request-id': requestId })) res.setHeader(name, value)
    const result = await route.handler({ req, res, url, params, body, requestId })
    if ('handled' in result) return
    reply(result.status, result.body, result.headers)
  }

  return (req, res) => {
    const requestId = makeId()
    const reply = replyWith(req, res, requestId)
    handle(req, res, requestId, reply).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return }
      if (error instanceof HttpError) {
        if (error.code) onRejected?.({ status: error.status, code: error.code, method: req.method ?? '', path: pathOf(req), requestId })
        // An oversized upload may still be streaming in; close the connection instead of draining it.
        return reply(error.status, { error: error.message }, error.status === 413 ? { connection: 'close' } : {})
      }
      log.error(`Unhandled error on ${req.method} ${req.url}`, error)
      reply(500, { error: 'Internal server error.' })
    })
  }
}
