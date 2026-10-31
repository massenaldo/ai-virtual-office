import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// The dev proxy's front door. In backend mode the browser calls same-origin /api/* on the Vite server; this middleware
// (which runs in Node, never in the browser) adds the bearer token, and Vite's proxy forwards the request to the backend.
// So the token is never in a bundle, a URL, a log or a page. Only requests the browser itself marks as same-origin pass:
// a cross-site page, an address-bar visit or a plain curl to this port gets a 403.

export type GateRequest = { url?: string; headers: Record<string, string | string[] | undefined> }
export type GateResponse = { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown }
type Gate = (req: GateRequest, res: GateResponse, next: () => void) => void

const refuse = (res: GateResponse, status: number, error: string) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error }))
}

const decoded = (text: string): string => { try { return decodeURIComponent(text) } catch { return text } }

/**
 * `api`: exactly `/api/<something>` in its plain form. `other`: nothing to do with the API. `variant`: anything that would
 * read as the API after case folding, decoding, slash collapsing or dot-segment removal but is not the plain form
 * (`/apiX`, `/API/x`, `/%61pi/x`, `/api%2Fx`, `//api/x`, `/api/../x`): refused, never forwarded and never given a token.
 */
export function classifyPath(url: string): 'api' | 'other' | 'variant' {
  const raw = url.split('?')[0]
  const normal = decoded(raw).replace(/\\/g, '/').replace(/^\/+/, '/').toLowerCase()
  if (!normal.startsWith('/api')) return 'other'
  const plain = raw.startsWith('/api/') && !/%(2e|2f|5c)/i.test(raw) && !raw.includes('\\') && !raw.includes('//') && !raw.slice(5).split('/').some((s) => s === '.' || s === '..')
  return plain ? 'api' : 'variant'
}

export function createApiGate(opts: { readToken(): string | null }): Gate {
  return (req, res, next) => {
    const kind = classifyPath(req.url ?? '')
    if (kind === 'other') return next()
    if (kind === 'variant') return refuse(res, 404, 'Not found.')
    if (req.headers['sec-fetch-site'] !== 'same-origin') return refuse(res, 403, 'The dev proxy only serves same-origin requests from this app.')
    const token = opts.readToken()
    if (token === null) return refuse(res, 503, 'The backend token is not available. Is the backend running?')
    for (const name of Object.keys(req.headers)) if (/^(authorization|cookie)$/i.test(name)) delete req.headers[name]
    req.headers.authorization = `Bearer ${token}`
    next()
  }
}

type Env = Record<string, string | undefined>

/** The configured API_TOKEN, else the token the backend wrote at start. Read on every request, so a backend restart is picked up. */
export function tokenReader(env: Env, cwd: string = process.cwd()): () => string | null {
  return () => {
    const configured = env.API_TOKEN?.trim()
    if (configured) return configured
    try {
      const text = readFileSync(resolve(cwd, env.DATA_DIR?.trim() || './data', 'api-token'), 'utf8').trim()
      return text === '' ? null : text
    } catch {
      return null
    }
  }
}

/** The proxy target and plugin, or null in browser-mock mode (VITE_WORKFORCE_API_URL is not "/"). */
export function apiProxyFor(env: Env): { plugin: Plugin; proxy: Record<string, { target: string; changeOrigin: boolean }> } | null {
  if (env.VITE_WORKFORCE_API_URL?.trim() !== '/') return null
  const gate = createApiGate({ readToken: tokenReader(env) })
  const plugin: Plugin = {
    name: 'vo-api-gate',
    // A plain hook runs before Vite's own proxy middleware, so the header is set before the request is forwarded.
    configureServer(server) {
      server.middlewares.use((req, res, next) => gate(req as unknown as GateRequest, res, next))
    },
  }
  // changeOrigin: the backend only accepts its own Host (127.0.0.1:<port>), so the proxy rewrites Host. Origin is kept.
  // The key is a regular expression (Vite reads a leading ^ that way): only the plain /api/ prefix is forwarded.
  return { plugin, proxy: { '^/api/': { target: `http://${env.HOST?.trim() || '127.0.0.1'}:${env.PORT?.trim() || '8787'}`, changeOrigin: true } } }
}
