import type { ConnectionStatus, WorkforceController, WorkforceSnapshot } from '../controller'
import { emptyWorkforce } from '../operations'
import { createApiClient, type ApiClient } from './client'
import { createRemoteCommands } from './commands'
import { createRemoteSync, type EventSourceLike, type RemoteSync } from './sync'

export type RemoteControllerOptions = {
  baseUrl: string
  fetch?: typeof fetch
  createEventSource?: (url: string) => EventSourceLike
  now?: () => string
  /** A bad VITE_WORKFORCE_API_URL: nothing connects, the error is shown, and every command fails with it. */
  configError?: string
}

/** The WorkforceController for backend mode: the server owns the state, this only mirrors it and sends commands. */
export function createRemoteWorkforceController(opts: RemoteControllerOptions): WorkforceController {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  let commandError: string | null = opts.configError ?? null
  let loadDismissed = false

  const client: ApiClient = opts.configError !== undefined
    ? { baseUrl: opts.baseUrl, get: async () => ({ ok: false, status: null, error: opts.configError! }), send: async () => ({ ok: false, status: null, error: opts.configError! }) }
    : createApiClient({ baseUrl: opts.baseUrl, fetch: opts.fetch })

  const sync: RemoteSync | null = opts.configError !== undefined
    ? null
    : createRemoteSync({ client, createEventSource: opts.createEventSource ?? ((url) => new EventSource(url)), now: opts.now })
  const unsubscribe = sync?.subscribe(notify)

  const setCommandError = (message: string | null) => {
    if (message === commandError) return
    commandError = message
    notify()
  }

  const commands = createRemoteCommands({ client, insertAgent: (agent) => sync?.insertAgentIfAbsent(agent), reportError: setCommandError })

  const misconfigured: Omit<WorkforceSnapshot, 'commandError'> = {
    state: emptyWorkforce(), loadProblem: null, preserved: null, saveError: null,
    environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'misconfigured' satisfies ConnectionStatus, lastSyncedAt: null,
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
    dispose() {
      unsubscribe?.()
      sync?.dispose()
      listeners.clear()
    },
  }
}
