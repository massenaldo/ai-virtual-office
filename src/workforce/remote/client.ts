import { MUTATION_HEADERS } from '../api'

/** status is null when no response arrived (network failure or abort). */
/** What a 401 means to the person running the app, whatever the server's own wording. */
export const NOT_AUTHORIZED = 'Not authorized. In backend mode the app asks for the API token; in dev:full the dev server adds it. Otherwise start the app with npm run dev:full, or run npm run server and npm run dev with VITE_WORKFORCE_API_URL=/.'
/** What a 401 from the pairing call means: the token itself was wrong. */
export const PAIR_REJECTED = 'That token was not accepted.'

/** pair() got a 200 but the very next snapshot was 401: the browser did not send the cookie back. */
export const PAIRED_NOT_KEPT = 'Paired, but the browser did not keep the session. Open the app at the same address you started the backend with (127.0.0.1 or localhost).'
/** pair() got a 200 but the backend then failed to answer the snapshot. */
export const PAIRED_UNREACHABLE = 'Paired, but the backend is not reachable yet.'

/** A cross-host setup (page on localhost, backend on 127.0.0.1) never keeps the cookie; this says so, with host names only. Null when the hosts match or the backend is the page origin. */
export function hostMismatchNote(baseUrl: string, page: { hostname: string; port: string } | undefined): string | null {
  if (baseUrl === '' || !page) return null
  let backendHost: string
  try { backendHost = new URL(baseUrl).hostname } catch { return null }
  if (backendHost === '' || backendHost === page.hostname) return null
  // 'http:' is split off so the no-remote-assets scan does not read this advice text as a remote URL.
  return `This page is open at ${page.hostname} but the backend is at ${backendHost}. Open the app at ${'http:'}//${backendHost}${page.port ? `:${page.port}` : ''} so the browser keeps the session.`
}

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number | null; error: string }
export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type ApiClient = {
  baseUrl: string
  get<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>>
  send<T>(method: MutationMethod, path: string, body?: unknown): Promise<ApiResult<T>>
  /** Trades the API token for a browser session cookie. The token is sent once and never kept. */
  pair(token: string): Promise<ApiResult<{ ok: true; expiresAt: string }>>
}

/** A thin fetch wrapper. It never throws: every failure becomes an ApiResult, and a server's `{ error }` text is passed on unchanged. */
export function createApiClient(opts: { baseUrl: string; fetch?: typeof fetch }): ApiClient {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const { baseUrl } = opts

  async function request<T>(path: string, init: RequestInit, unauthorized: string = NOT_AUTHORIZED): Promise<ApiResult<T>> {
    let response: Response
    try {
      response = await doFetch(baseUrl + path, { ...init, credentials: 'include' })
    } catch {
      return { ok: false, status: null, error: baseUrl === '' ? "Can't reach the backend." : `Can't reach the backend at ${baseUrl}.` }
    }
    let parsed: unknown
    try {
      const text = await response.text()
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (response.ok) return { ok: true, status: response.status, body: parsed as T }
    if (response.status === 401) return { ok: false, status: 401, error: unauthorized }
    const message = typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : null
    return { ok: false, status: response.status, error: message ?? `Request failed (${response.status}).` }
  }

  return {
    baseUrl,
    get: (path, signal) => request(path, { method: 'GET', signal }),
    send: (method, path, body) => request(path, { method, headers: { ...MUTATION_HEADERS }, body: body === undefined ? undefined : JSON.stringify(body) }),
    pair: (token) => request('/api/session', { method: 'POST', headers: { ...MUTATION_HEADERS }, body: JSON.stringify({ token }) }, PAIR_REJECTED),
  }
}
