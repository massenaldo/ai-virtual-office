import { request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { classifyPath } from '../../scripts/apiProxy'
import { consoleLogger, type Logger } from '../log'

// Forwards /api/* to the loopback backend. The client's credentials stop here: only an allow list of its headers is
// passed on, and the backend's bearer token is injected from readToken() on every request. The token is never written
// to a response or a log line. Responses (the event stream included) are piped through as they arrive.

export type ApiProxyOptions = { backend: { host: string; port: number }; readToken(): string | null; log?: Logger }

const MAX_BODY_BYTES = 1024 * 1024
// Everything else (Authorization, Cookie, Origin, Referer, X-Forwarded-*, Forwarded, Sec-Fetch-*, Accept-Encoding) is dropped.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'last-event-id', 'user-agent']
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function refuseBody(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('connection', 'close')
  sendJson(res, 413, 'The request body is too large.')
  // Only after the answer is out, or the client would see a reset instead of the 413.
  res.once('finish', () => req.destroy())
}

function sendJson(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) return void res.destroy()
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ error }))
}

export function createApiProxy(opts: ApiProxyOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = opts.log ?? consoleLogger

  function forward(req: IncomingMessage, res: ServerResponse, token: string, body: Buffer): void {
    const headers: OutgoingHttpHeaders = {}
    for (const name of FORWARDED_REQUEST_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
    headers.host = `127.0.0.1:${opts.backend.port}`
    headers.authorization = `Bearer ${token}`
    headers['accept-encoding'] = 'identity'
    if (body.length > 0) headers['content-length'] = String(body.length)
    // One connection per request: closing the client's request then closes exactly this upstream connection.
    const upstream = request({ host: opts.backend.host, port: opts.backend.port, method: req.method, path: req.url, headers, agent: false }, (up) => {
      const out: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(up.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value
      out['cache-control'] = 'no-store'
      const streaming = String(up.headers['content-type'] ?? '').startsWith('text/event-stream')
      if (streaming) out['x-accel-buffering'] = 'no'
      res.writeHead(up.statusCode ?? 502, out)
      if (streaming) res.flushHeaders()
      up.on('error', () => res.destroy())
      // A stream that ends without its terminator was cut: drop the client instead of ending it as if it were complete.
      up.on('close', () => { if (!up.complete) res.destroy() })
      up.pipe(res)
    })
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      log.warn(`The backend request failed (${err.code ?? 'error'}).`)
      sendJson(res, 502, 'The backend is not reachable.')
    })
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    upstream.end(body)
  }

  return (req, res) => {
    const kind = classifyPath(req.url ?? '')
    if (kind !== 'api') return sendJson(res, 404, 'Not found.')
    if (req.headers['sec-fetch-site'] !== 'same-origin') return sendJson(res, 403, 'The gateway only serves requests from this app.')
    const token = opts.readToken()
    if (token === null) return sendJson(res, 503, 'The backend token is not available. Is the backend running?')

    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BODY_BYTES) {
      return refuseBody(req, res)
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        refuseBody(req, res)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!tooLarge) forward(req, res, token, Buffer.concat(chunks)) })
    req.on('error', () => res.destroy())
  }
}
