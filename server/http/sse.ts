import type { ServerResponse } from 'node:http'
import type { WorkforceEvent } from '../../src/workforce/api'
import type { EventLog } from '../eventLog'
import type { Logger } from '../log'
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

export function eventsRoute(deps: { events: EventLog; heartbeatMs: number; streams: Set<ServerResponse>; now: () => string; log: Logger; maxStreams?: number; maxBufferBytes?: number }): Route {
  const { events, heartbeatMs, streams, now, log, maxStreams = MAX_EVENT_STREAMS, maxBufferBytes = MAX_STREAM_BUFFER_BYTES } = deps
  return {
    method: 'GET',
    path: '/api/events',
    body: 'none',
    handler: ({ req, res, url }) => {
      if (streams.size >= maxStreams) throw new HttpError(503, `Too many open event streams (limit ${maxStreams}).`, 'stream_limit')
      const header = req.headers['last-event-id']
      const resume = (typeof header === 'string' && header !== '' ? header : null) ?? (url.searchParams.get('lastEventId') || null)

      let cleaned = false
      let off = () => {}
      let timer: ReturnType<typeof setInterval> | undefined
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        off()
        if (timer) clearInterval(timer)
        streams.delete(res)
      }
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
        timer = setInterval(() => { send(': ping\n\n') }, heartbeatMs)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      res.on('error', cleanup)
      return { handled: true }
    },
  }
}
