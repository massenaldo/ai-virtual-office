import type { ServerResponse } from 'node:http'
import type { WorkforceEvent } from '../../src/workforce/api'
import type { EventLog } from '../eventLog'
import { tokenMatches } from '../auth'
import type { Logger } from '../log'
import { authenticatedSession, sessionKey, type SessionStore } from '../session'
import { HttpError, type Route } from './router'

/**
 * GET /api/events: typed workforce events as server-sent events.
 *
 * Client recovery contract (Stage D's RemoteWorkforceController follows it):
 *   1. GET /api/state for the full state and its lastEventId.
 *   2. Open EventSource('/api/events?lastEventId=<that id>'); the query form exists because a browser's EventSource can't
 *      send the Last-Event-ID header on its first connect (on automatic reconnects it sends the header itself).
 *   3. Apply only events after the snapshot, in order, with applyWorkforceEvent.
 *   4. On a state.reset event (the id was too old, from another server run, or ahead of the server) reload the snapshot.
 */

export const HEARTBEAT_MS = 15000
export const RETRY_MS = 3000
export const MAX_EVENT_STREAMS = 20
export const MAX_STREAM_BUFFER_BYTES = 1048576

export function formatSseFrame(e: WorkforceEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
}

export function eventsRoute(deps: { events: EventLog; heartbeatMs: number; streams: Set<ServerResponse>; now: () => string; log: Logger; maxStreams?: number; maxBufferBytes?: number; sessions: SessionStore; apiToken: string }): Route {
  const { events, heartbeatMs, streams, now, log, sessions, apiToken, maxStreams = MAX_EVENT_STREAMS, maxBufferBytes = MAX_STREAM_BUFFER_BYTES } = deps
  // Streams opened by a cookie-only request, by session key. Auth runs once at open, so a session that ends (logout,
  // eviction, expiry) must close its streams itself. Bearer streams have no session and are never listed here.
  const bySession = new Map<string, Set<() => void>>()
  sessions.onEnd((key) => { for (const close of [...(bySession.get(key) ?? [])]) close() })
  return {
    method: 'GET',
    path: '/api/events',
    body: 'none',
    handler: ({ req, res, url }) => {
      if (streams.size >= maxStreams) throw new HttpError(503, `Too many open event streams (limit ${maxStreams}).`, 'stream_limit')
      const header = req.headers['last-event-id']
      const resume = (typeof header === 'string' && header !== '' ? header : null) ?? (url.searchParams.get('lastEventId') || null)

      // The auth guard already let this request in; a valid bearer wins over a cookie, as it does there.
      const sessionId = tokenMatches(apiToken, req.headers.authorization) ? undefined : authenticatedSession(req, sessions)
      const key = sessionId === undefined ? undefined : sessionKey(sessionId)
      let cleaned = false
      let off = () => {}
      let timer: ReturnType<typeof setInterval> | undefined
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        off()
        if (timer) clearInterval(timer)
        streams.delete(res)
        if (key !== undefined) {
          const set = bySession.get(key)
          set?.delete(end)
          if (set?.size === 0) bySession.delete(key)
        }
      }
      const end = () => { if (cleaned) return; res.end(); cleanup() }
      // A client that stops reading must not make the server buffer without bound: it is cut off and can reconnect.
      const send = (text: string) => {
        if (cleaned) return
        res.write(text)
        if (res.writableLength > maxBufferBytes) {
          log.warn('Closed a slow event stream (over 1 MB buffered).')
          res.end()
          cleanup()
        }
      }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      streams.add(res)
      send(`retry: ${RETRY_MS}\n\n`)

      // Replay (or reset) and subscribe in one tick, so no event is lost or sent twice in between.
      const replay = events.since(resume)
      if (replay.kind === 'replay') for (const event of replay.events) send(formatSseFrame(event))
      else send(formatSseFrame({ id: events.lastEventId, type: 'state.reset', at: now(), reason: 'gap' }))

      if (!cleaned) {
        off = events.subscribe((event) => { send(formatSseFrame(event)) })
        if (key !== undefined) bySession.set(key, (bySession.get(key) ?? new Set()).add(end))
        timer = setInterval(() => {
          if (sessionId !== undefined && !sessions.valid(sessionId)) return end()
          send(': ping\n\n')
        }, heartbeatMs)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      res.on('error', cleanup)
      return { handled: true }
    },
  }
}
