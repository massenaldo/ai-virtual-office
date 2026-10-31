import type { StateResponse, HealthResponse, WorkforceEvent } from '../api'

// Test doubles for fetch and EventSource. Never imported by the app.

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body: string | undefined }

const DEFAULT_HEALTH: HealthResponse = { ok: true, version: 'test', runtime: 'mock', available: true, reason: null, credentialsConfigured: false, startedAt: '2026-10-31T09:00:00.000Z' }

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' } })

export function createFakeBackend(opts: { baseUrl: string; state: StateResponse; health?: HealthResponse }) {
  let state = opts.state
  const replies = new Map<string, { status: number; body: unknown }>()
  const held = new Map<string, Promise<void>>()
  const calls: FakeCall[] = []
  const backend = {
    calls,
    down: false,
    setState(s: StateResponse) { state = s },
    respond(method: string, path: string, status: number, body: unknown) { replies.set(`${method} ${path}`, { status, body }) },
    /** The next request to `path` waits until the returned function is called. */
    hold(path: string): () => void {
      let release!: () => void
      held.set(path, new Promise<void>((resolve) => { release = resolve }))
      return release
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
      calls.push({ method, url, headers, body: typeof init?.body === 'string' ? init.body : undefined })
      if (backend.down) throw new TypeError('Failed to fetch')
      const path = url.slice(opts.baseUrl.length).split('?')[0]
      const gate = held.get(path)
      if (gate) {
        held.delete(path)
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (init?.signal?.aborted) return abort()
          init?.signal?.addEventListener('abort', abort)
          void gate.then(resolve)
        })
      }
      if (backend.down) throw new TypeError('Failed to fetch')
      const scripted = replies.get(`${method} ${path}`)
      if (scripted) return reply(scripted.status, scripted.body)
      if (method === 'GET' && path === '/api/state') return reply(200, state)
      if (method === 'GET' && path === '/api/health') return reply(200, opts.health ?? DEFAULT_HEALTH)
      return reply(200, {})
    }) as typeof fetch,
  }
  return backend
}

type Listener = (e: { data?: string }) => void

export class FakeEventSource {
  static instances: FakeEventSource[] = []
  static reset(): void { FakeEventSource.instances = [] }
  closed = false
  private listeners = new Map<string, Listener[]>()
  constructor(public url: string) { FakeEventSource.instances.push(this) }
  addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  close(): void { this.closed = true }
  open(): void { this.dispatch('open', {}) }
  fail(): void { this.dispatch('error', {}) }
  emit(e: WorkforceEvent): void { this.dispatch(e.type, { data: JSON.stringify(e) }) }
  emitRaw(type: string, data: string): void { this.dispatch(type, { data }) }
  private dispatch(type: string, e: { data?: string }): void {
    if (this.closed) return
    for (const fn of this.listeners.get(type) ?? []) fn(e)
  }
}
