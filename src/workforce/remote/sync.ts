import { applyWorkforceEvent, parseEventId, WORKFORCE_EVENT_TYPES, type HealthResponse, type StateResponse, type WorkforceEvent } from '../api'
import type { WorkforceSnapshot } from '../controller'
import { emptyWorkforce } from '../operations'
import type { Agent } from '../types'
import type { ApiClient } from './client'

export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void
  close(): void
}
export type SyncSnapshot = Pick<WorkforceSnapshot, 'state' | 'loadProblem' | 'preserved' | 'saveError' | 'environment' | 'connection' | 'lastSyncedAt' | 'connectionError'>
export type RemoteSync = {
  getSnapshot(): SyncSnapshot
  subscribe(listener: () => void): () => void
  /** Adds the agent unless an event already delivered it (an event's copy is never older than the response's). */
  insertAgentIfAbsent(agent: Agent): void
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
export function createRemoteSync(opts: { client: ApiClient; createEventSource: (url: string) => EventSourceLike; now?: () => string }): RemoteSync {
  const { client } = opts
  const now = opts.now ?? (() => new Date().toISOString())
  const listeners = new Set<() => void>()
  let snap: SyncSnapshot = { state: emptyWorkforce(), loadProblem: null, preserved: null, saveError: null, environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'connecting', lastSyncedAt: null, connectionError: null }
  let generation = 0
  let cursor: { boot: string; seq: number } | null = null
  let stream: EventSourceLike | null = null
  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let resetStreak = 0
  let disposed = false

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
    publish({ state: applyWorkforceEvent(snap.state, event), lastSyncedAt: now() })
  }

  async function connect(): Promise<void> {
    if (disposed) return
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
    if (g !== generation) return
    const parsed = r.ok ? parseEventId(r.body.lastEventId) : null
    if (!r.ok) { goOffline(r.error); return }
    if (!parsed) { goOffline('The backend sent an invalid event id.'); return }
    cursor = parsed
    publish({ state: r.body.state, loadProblem: r.body.loadProblem, preserved: r.body.preserved, saveError: r.body.saveError, lastSyncedAt: now() })

    const source = opts.createEventSource(`${client.baseUrl}/api/events?lastEventId=${encodeURIComponent(r.body.lastEventId)}`)
    stream = source
    for (const name of WORKFORCE_EVENT_TYPES) source.addEventListener(name, (e) => onFrame(g, name, e.data))
    source.addEventListener('open', () => {
      if (g !== generation) return
      attempt = 0
      publish({ connection: 'live', connectionError: null })
    })
    source.addEventListener('error', () => { if (g === generation) goOffline('The event stream was interrupted.') })
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
    dispose() {
      disposed = true
      stop()
      listeners.clear()
    },
  }
}
