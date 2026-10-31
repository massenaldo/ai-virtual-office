import type { IncomingMessage } from 'node:http'
import type { Guard, RejectInfo, Reply } from './router'

// The browser-facing guards. Order matters: Host first (it stops DNS rebinding, where a hostile page reaches the API under
// its own name), then Origin (it stops other web pages), then preflight, then the JSON-only rule (it turns a cross-origin
// "simple request" into one that needs a preflight, which the Origin guard denies).

export const ALLOWED_HOST_NAMES = ['127.0.0.1', 'localhost', '[::1]'] as const
export const PREFLIGHT_MAX_AGE_S = 600
export const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE'
export const CORS_HEADERS = 'Content-Type, Last-Event-ID'

export type GuardOptions = { allowedOrigins: readonly string[]; onReject?: (r: RejectInfo) => void }

const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE']

export function createSecurityGuards({ allowedOrigins, onReject }: GuardOptions): Guard[] {
  const refuse = (req: IncomingMessage, url: URL, requestId: string, status: number, code: RejectInfo['code'], error: string): Reply => {
    onReject?.({ status, code, method: req.method ?? '', path: url.pathname.slice(0, 128), requestId })
    return { status, body: { error } }
  }

  // localPort is the port the connection actually arrived on, so this is right even with PORT=0.
  const host: Guard = (req, url, { requestId }) => {
    const header = (req.headers.host ?? '').toLowerCase()
    return ALLOWED_HOST_NAMES.some((name) => header === `${name}:${req.socket.localPort}`) ? null : refuse(req, url, requestId, 421, 'host', 'Host not allowed.')
  }

  // Applies to every method, including GET and the event stream. A request with no Origin (curl, a same-origin page) passes.
  const origin: Guard = (req, url, { requestId }) => {
    const value = req.headers.origin
    return value === undefined || allowedOrigins.includes(value) ? null : refuse(req, url, requestId, 403, 'origin', 'Origin not allowed.')
  }

  const preflight: Guard = (req): Reply | null => {
    if (req.method !== 'OPTIONS') return null
    const value = req.headers.origin
    if (value === undefined) return { status: 204, body: null, headers: { allow: `${CORS_METHODS}, OPTIONS` } }
    return { status: 204, body: null, headers: { 'access-control-allow-origin': value, 'access-control-allow-methods': CORS_METHODS, 'access-control-allow-headers': CORS_HEADERS, 'access-control-max-age': String(PREFLIGHT_MAX_AGE_S) } }
  }

  // Covers body-less routes too (cancel, the demo POSTs, DELETE): their bodies are never read, but the header is still required.
  const jsonOnly: Guard = (req, url, { requestId }) => {
    if (!STATE_CHANGING.includes(req.method ?? '')) return null
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    return type === 'application/json' ? null : refuse(req, url, requestId, 415, 'content_type', 'Content-Type must be application/json.')
  }

  return [host, origin, preflight, jsonOnly]
}

/** Headers for every reply. CORS headers appear only for an allowed Origin, never as `*`, and never with credentials. */
export function securityHeaders(req: IncomingMessage, allowedOrigins: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    // JSON replies set this themselves; the event stream writes its own headers, so it comes from here too.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    vary: 'Origin',
  }
  const origin = req.headers.origin
  if (origin !== undefined && allowedOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-expose-headers'] = 'X-Request-Id'
  }
  return headers
}
