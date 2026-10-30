import type { ServerResponse } from 'node:http'
import type { WorkforceEvent } from '../../src/workforce/api'
import type { EventLog } from '../eventLog'
import type { Route } from './router'

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

export function formatSseFrame(e: WorkforceEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
}

export function eventsRoute(deps: { events: EventLog; heartbeatMs: number; streams: Set<ServerResponse>; now: () => string }): Route {
  const { events, heartbeatMs, streams, now } = deps
  return {
    method: 'GET',
    path: '/api/events',
    body: 'none',
    handler: ({ req, res, url }) => {
      const header = req.headers['last-event-id']
      const resume = (typeof header === 'string' && header !== '' ? header : null) ?? (url.searchParams.get('lastEventId') || null)

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(`retry: ${RETRY_MS}\n\n`)

      // Replay (or reset) and subscribe in one tick, so no event is lost or sent twice in between.
      const replay = events.since(resume)
      if (replay.kind === 'replay') for (const event of replay.events) res.write(formatSseFrame(event))
      else res.write(formatSseFrame({ id: events.lastEventId, type: 'state.reset', at: now(), reason: 'gap' }))

      const off = events.subscribe((event) => { res.write(formatSseFrame(event)) })
      const timer = setInterval(() => { res.write(': ping\n\n') }, heartbeatMs)
      streams.add(res)

      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        off()
        clearInterval(timer)
        streams.delete(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      res.on('error', cleanup)
      return { handled: true }
    },
  }
}
