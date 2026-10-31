import { MUTATION_HEADERS } from '../api'

/** status is null when no response arrived (network failure or abort). */
export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number | null; error: string }
export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type ApiClient = {
  baseUrl: string
  get<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>>
  send<T>(method: MutationMethod, path: string, body?: unknown): Promise<ApiResult<T>>
}

/** A thin fetch wrapper. It never throws: every failure becomes an ApiResult, and a server's `{ error }` text is passed on unchanged. */
export function createApiClient(opts: { baseUrl: string; fetch?: typeof fetch }): ApiClient {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const { baseUrl } = opts

  async function request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
    let response: Response
    try {
      response = await doFetch(baseUrl + path, init)
    } catch {
      return { ok: false, status: null, error: `Can't reach the backend at ${baseUrl}.` }
    }
    let parsed: unknown
    try {
      const text = await response.text()
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (response.ok) return { ok: true, status: response.status, body: parsed as T }
    const message = typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : null
    return { ok: false, status: response.status, error: message ?? `Request failed (${response.status}).` }
  }

  return {
    baseUrl,
    get: (path, signal) => request(path, { method: 'GET', signal }),
    send: (method, path, body) => request(path, { method, headers: { ...MUTATION_HEADERS }, body: body === undefined ? undefined : JSON.stringify(body) }),
  }
}
