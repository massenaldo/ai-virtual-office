import type { ConnectionStatus, WorkforceController, WorkforceSnapshot } from '../controller'
import { emptyWorkforce } from '../operations'
import { createApiClient, hostMismatchNote, PAIRED_NOT_KEPT, PAIRED_UNREACHABLE, type ApiClient, type MutationMethod } from './client'
import { createRemoteCommands } from './commands'
import { createRemoteSync, type EventSourceLike, type RemoteSync } from './sync'

export type RemoteControllerOptions = {
  baseUrl: string
  fetch?: typeof fetch
  createEventSource?: (url: string, opts: { withCredentials: boolean }) => EventSourceLike
  now?: () => string
  /** A bad VITE_WORKFORCE_API_URL: nothing connects, the error is shown, and every command fails with it. */
  configError?: string
  /** The page's own host name and port, for the cross-host pairing note. Defaults to globalThis.location. */
  location?: { hostname: string; port: string }
}

/** The WorkforceController for backend mode: the server owns the state, this only mirrors it and sends commands. */
export function createRemoteWorkforceController(opts: RemoteControllerOptions): WorkforceController {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  let commandError: string | null = opts.configError ?? null
  let loadDismissed = false

  const client: ApiClient = opts.configError !== undefined
    ? { baseUrl: opts.baseUrl, get: async () => ({ ok: false, status: null, error: opts.configError! }), send: async () => ({ ok: false, status: null, error: opts.configError! }), pair: async () => ({ ok: false, status: null, error: opts.configError! }) }
    : createApiClient({ baseUrl: opts.baseUrl, fetch: opts.fetch })

  const sync: RemoteSync | null = opts.configError !== undefined
    ? null
    : createRemoteSync({ client, createEventSource: opts.createEventSource ?? ((url, o) => new EventSource(url, o)), now: opts.now, pairingNote: hostMismatchNote(opts.baseUrl, opts.location ?? globalThis.location) })
  const unsubscribe = sync?.subscribe(notify)

  const setCommandError = (message: string | null) => {
    if (message === commandError) return
    commandError = message
    notify()
  }

  // A command's 401 means the session is gone: reload the snapshot at once so needsPairing is set, not just a NOT_AUTHORIZED message.
  const commandClient: ApiClient = {
    ...client,
    send: async <T,>(method: MutationMethod, path: string, body?: unknown) => {
      const r = await client.send<T>(method, path, body)
      if (!r.ok && r.status === 401 && sync && !sync.getSnapshot().needsPairing) void sync.reconnect()
      return r
    },
  }
  const commands = createRemoteCommands({ client: commandClient, insertAgent: (agent) => sync?.insertAgentIfAbsent(agent), reportError: setCommandError })

  const misconfigured: Omit<WorkforceSnapshot, 'commandError'> = {
    state: emptyWorkforce(), loadProblem: null, preserved: null, saveError: null,
    environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'misconfigured' satisfies ConnectionStatus, lastSyncedAt: null, connectionError: null, needsPairing: false, pairingNote: null,
  }

  // useSyncExternalStore needs the same object back until something changed.
  let cached: WorkforceSnapshot | null = null
  let from: { sync: object; commandError: string | null; loadDismissed: boolean } | null = null
  const getSnapshot = (): WorkforceSnapshot => {
    const base = sync ? sync.getSnapshot() : misconfigured
    if (cached && from && from.sync === base && from.commandError === commandError && from.loadDismissed === loadDismissed) return cached
    from = { sync: base, commandError, loadDismissed }
    cached = { ...base, loadProblem: loadDismissed ? null : base.loadProblem, commandError }
    return cached
  }

  return {
    ...commands,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dismissLoadProblem() {
      if (loadDismissed || !getSnapshot().loadProblem) return
      loadDismissed = true
      notify()
    },
    dismissCommandError: () => setCommandError(null),
    async pair(token) {
      const r = await client.pair(token)
      if (!r.ok) return { ok: false, error: r.error }
      const outcome = await sync?.reconnect()
      if (outcome === 'unauthorized') return { ok: false, error: PAIRED_NOT_KEPT }
      if (outcome === 'failed') return { ok: false, error: PAIRED_UNREACHABLE }
      return { ok: true }
    },
    dispose() {
      unsubscribe?.()
      sync?.dispose()
      listeners.clear()
    },
  }
}
