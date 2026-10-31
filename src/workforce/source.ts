import { createWorkforceController, type WorkforceController } from './controller'
import { createRemoteWorkforceController } from './remote/remoteController'
import type { EventSourceLike } from './remote/sync'

export type WorkforceSource = { kind: 'browser' } | { kind: 'backend'; baseUrl: string } | { kind: 'invalid'; error: string }

/** Empty means the browser mock; "/" or an http(s) origin means the local backend; anything else is a config error, never a silent fallback. */
export function resolveWorkforceSource(raw: string | undefined): WorkforceSource {
  const value = (raw ?? '').trim()
  if (value === '') return { kind: 'browser' }
  // "/" means the page's own origin, where the dev proxy adds the token and forwards /api to the backend.
  if (value === '/') return { kind: 'backend', baseUrl: '' }
  const invalid: WorkforceSource = { kind: 'invalid', error: `VITE_WORKFORCE_API_URL must be an http(s) origin such as http://127.0.0.1:8787 (got "${value}").` }
  try {
    const url = new URL(value)
    const originOnly = url.pathname === '/' && url.search === '' && url.hash === ''
    return (url.protocol === 'http:' || url.protocol === 'https:') && originOnly ? { kind: 'backend', baseUrl: url.origin } : invalid
  } catch {
    return invalid
  }
}

export function createControllerFor(
  source: WorkforceSource,
  deps: { storage: Pick<Storage, 'getItem' | 'setItem'> | null; fetch?: typeof fetch; createEventSource?: (url: string) => EventSourceLike },
): WorkforceController {
  switch (source.kind) {
    case 'browser': return createWorkforceController({ storage: deps.storage })
    case 'backend': return createRemoteWorkforceController({ baseUrl: source.baseUrl, fetch: deps.fetch, createEventSource: deps.createEventSource })
    case 'invalid': return createRemoteWorkforceController({ baseUrl: '', configError: source.error })
  }
}
