import { applyWorkforceEvent, parseEventId, WORKFORCE_EVENT_TYPES, type HealthResponse, type PermissionChangedEvent, type PermissionsResponse, type StateResponse, type WorkforceEvent } from '../api'
import type { WorkforceSnapshot } from '../controller'
import { emptyWorkforce } from '../operations'
import { applyPermissionEvent, emptyPermissions, parsePermissionLists, withLists, type PermissionsState } from '../permissions'
import type { Agent } from '../types'
import type { ApiClient } from './client'

export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
}
export type SyncSnapshot = Pick<WorkforceSnapshot, 'state' | 'loadProblem' | 'preserved' | 'saveError' | 'environment' | 'connection' | 'lastSyncedAt' | 'connectionError' | 'needsPairing' | 'pairingNote'> & { permissions: PermissionsState }
/** How the snapshot answered a (re)connect: ok (or superseded), 401, or any other failure. */
export type ReconnectOutcome = 'ok' | 'unauthorized' | 'failed'
export type RemoteSync = {
  getSnapshot(): SyncSnapshot
  subscribe(listener: () => void): () => void
  /** Adds the agent unless an event already delivered it (an event's copy is never older than the response's). */
  insertAgentIfAbsent(agent: Agent): void
  /** Starts over from the snapshot right now (used after pairing); also leaves the stopped state of needsPairing. */
  reconnect(): Promise<ReconnectOutcome>
  dispose(): void
}

/** 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s forever. */
export const reconnectDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 30000)

/**
 * Keeps a local copy of the backend's state: load the snapshot, open the event stream at its last event id, apply
 * newer events, and start over (snapshot again) whenever the copy can no longer be trusted. The browser's own
 * EventSource retry is never used: every error closes the stream and goes through the backoff here.
 * Each connect has a generation number, so a late response or stream callback from an older connect changes nothing.
 */
export function createRemoteSync(opts: { client: ApiClient; createEventSource: (url: string, opts: { withCredentials: boolean }) => EventSourceLike; now?: () => string; pairingNote?: string | null }): RemoteSync {
  const { client } = opts
  const now = opts.now ?? (() => new Date().toISOString())
  const listeners = new Set<() => void>()
  let snap: SyncSnapshot = { state: emptyWorkforce(), loadProblem: null, preserved: null, saveError: null, environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'connecting', lastSyncedAt: null, connectionError: null, needsPairing: false, pairingNote: null, permissions: emptyPermissions() }
  let generation = 0
  let cursor: { boot: string; seq: number } | null = null
  let stream: EventSourceLike | null = null
  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let resetStreak = 0
  let disposed = false
  /** Permission events that arrived while the lists were loading: the lists may be older than they are, so they are applied again on top. */
  let buffered: PermissionChangedEvent[] | null = null

  const publish = (patch: Partial<SyncSnapshot>) => {
    snap = { ...snap, ...patch }
    listeners.forEach((l) => l())
  }

  const stop = () => {
    generation += 1
    abort?.abort()
    abort = null
    stream?.close()
    stream = null
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const goOffline = (reason: string) => {
    stop()
    if (disposed) return
    publish({ connection: 'offline', connectionError: reason })
    timer = setTimeout(() => { timer = null; void connect() }, reconnectDelay(attempt))
    attempt += 1
  }

  /** A 401: only a pairing can fix it, so there is no retry timer. reconnect() starts again. */
  const needPairing = (reason: string) => {
    stop()
    if (disposed) return
    publish({ connection: 'offline', connectionError: reason, needsPairing: true, pairingNote: opts.pairingNote ?? null })
  }

  /** A trusted-copy failure: reload the snapshot at once, or after a growing delay when it keeps happening. */
  const resync = () => {
    stop()
    if (disposed) return
    resetStreak += 1
    if (snap.connection !== 'connecting') publish({ connection: 'connecting' })
    if (resetStreak === 1) { void connect(); return }
    timer = setTimeout(() => { timer = null; void connect() }, reconnectDelay(resetStreak - 2))
  }

  const onFrame = (g: number, name: string, data: string | undefined) => {
    if (g !== generation) return
    if (name === 'state.reset') { resync(); return }
    let event: WorkforceEvent
    try { event = JSON.parse(data ?? '') as WorkforceEvent } catch { resync(); return }
    const id = typeof event?.id === 'string' ? parseEventId(event.id) : null
    if (!id || (cursor && id.boot !== cursor.boot)) { resync(); return }
    if (cursor && id.seq <= cursor.seq) return
    cursor = id
    resetStreak = 0
    if (event.type === 'permission.changed') {
      buffered?.push(event)
      publish({ permissions: applyPermissionEvent(snap.permissions, event), lastSyncedAt: now() })
      return
    }
    publish({ state: applyWorkforceEvent(snap.state, event), lastSyncedAt: now() })
  }

  /** Both lists, loaded together: a failure or a malformed body keeps the lists as they were and records why. */
  async function loadPermissions(g: number, signal: AbortSignal): Promise<void> {
    const events: PermissionChangedEvent[] = []
    buffered = events
    const [active, history] = await Promise.all([client.get<PermissionsResponse>('/api/permissions', signal), client.get<PermissionsResponse>('/api/permissions/history', signal)])
    if (g !== generation) return
    buffered = null
    const failed = !active.ok ? active.error : !history.ok ? history.error : null
    const lists = active.ok && history.ok ? parsePermissionLists(active.body, history.body) : null
    if (!lists) {
      const error = failed ?? 'The backend sent an invalid permission list.'
      if (snap.permissions.error !== error) publish({ permissions: { ...snap.permissions, error } })
      return
    }
    publish({ permissions: events.reduce(applyPermissionEvent, withLists(snap.permissions, lists.active, lists.history)) })
  }

  async function connect(): Promise<ReconnectOutcome> {
    if (disposed) return 'ok'
    stop()
    const g = generation
    const controller = new AbortController()
    abort = controller
    if (snap.connection !== 'connecting') publish({ connection: 'connecting' })

    const pending = client.get<StateResponse>('/api/state', controller.signal)
    void client.get<HealthResponse>('/api/health', controller.signal).then((r) => {
      if (g !== generation || !r.ok) return
      const { runtime, available, reason } = r.body
      publish({ environment: { kind: 'backend', runtime, available, reason } })
    })

    const r = await pending
    if (g !== generation) return 'ok'
    const parsed = r.ok ? parseEventId(r.body.lastEventId) : null
    if (!r.ok && r.status === 401) { needPairing(r.error); return 'unauthorized' }
    if (!r.ok) { goOffline(r.error); return 'failed' }
    if (!parsed) { goOffline('The backend sent an invalid event id.'); return 'failed' }
    cursor = parsed
    publish({ needsPairing: false, pairingNote: null, state: r.body.state, loadProblem: r.body.loadProblem, preserved: r.body.preserved, saveError: r.body.saveError, lastSyncedAt: now() })

    const source = opts.createEventSource(`${client.baseUrl}/api/events?lastEventId=${encodeURIComponent(r.body.lastEventId)}`, { withCredentials: true })
    stream = source
    for (const name of [...WORKFORCE_EVENT_TYPES, 'permission.changed']) source.addEventListener(name, (e) => onFrame(g, name, e.data))
    void loadPermissions(g, controller.signal)
    source.addEventListener('open', () => {
      if (g !== generation) return
      attempt = 0
      publish({ connection: 'live', connectionError: null })
    })
    source.addEventListener('error', () => { if (g === generation) goOffline('The event stream was interrupted.') })
    return 'ok'
  }

  void connect()

  return {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    insertAgentIfAbsent(agent) {
      if (disposed || snap.state.agents.some((a) => a.id === agent.id)) return
      publish({ state: { ...snap.state, agents: [...snap.state.agents, agent] } })
    },
    reconnect() {
      if (disposed) return Promise.resolve('ok')
      attempt = 0
      resetStreak = 0
      return connect()
    },
    dispose() {
      disposed = true
      stop()
      listeners.clear()
    },
  }
}
