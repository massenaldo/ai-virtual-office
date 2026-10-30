import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../eventLog'
import { silentLogger } from '../log'
import { eventsRoute } from './sse'
import type { ChangeEvent } from '../../src/workforce/api'
import { openEventStream, type SseStream } from '../test/sseClient'
import { startTestServer, type TestServer } from '../test/helpers'

let s: TestServer | null = null
const open: SseStream[] = []
afterEach(async () => {
  open.splice(0).forEach((x) => x.close())
  await s?.close()
  s = null
})

const stream = async (opts?: Parameters<typeof openEventStream>[1]) => {
  const x = await openEventStream(s!.url, opts)
  open.push(x)
  return x
}
const poll = async (fn: () => boolean, ms = 500) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const nova = { name: 'Nova', role: 'Researcher', department: 'backend' }

describe('GET /api/events', () => {
  it('streams with SSE headers and a retry hint', async () => {
    s = await startTestServer()
    const x = await stream()
    expect(x.response.status).toBe(200)
    expect(x.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(x.response.headers.get('cache-control')).toBe('no-cache, no-transform')
    await poll(() => x.raw.length > 0)
    expect(x.raw[0]).toContain('retry: 3000')
  })

  it('sends heartbeats', async () => {
    s = await startTestServer({}, { heartbeatMs: 50 })
    const x = await stream()
    await poll(() => x.comments.includes(' ping'), 500)
  })

  it('delivers a change with a matching id', async () => {
    s = await startTestServer()
    const x = await stream()
    await s.api('POST', '/api/agents', nova)
    const e = (await x.next((ev) => ev.type === 'state.changed')) as ChangeEvent
    expect(e.patch.agents[0].name).toBe('Nova')
    expect(e.id).toMatch(/^[0-9a-z]+:\d+$/)
    expect(Number(e.id.split(':')[1])).toBeGreaterThanOrEqual(1)
  })

  it('cleans up on disconnect', async () => {
    s = await startTestServer()
    const x = await stream()
    expect(s.app.events.listenerCount()).toBe(1)
    expect(s.app.streams.size).toBe(1)
    x.close()
    await poll(() => s!.app.events.listenerCount() === 0 && s!.app.streams.size === 0)
  })

  it('replays after Last-Event-ID, by header and by query', async () => {
    s = await startTestServer({}, { mockTimings: { thinkingMs: 30, workingMs: 30 } })
    const a = await stream()
    await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API' })
    const started = await a.next((e) => e.type === 'task.started')
    await a.until((e) => e.type === 'agent.status_changed' && (e as ChangeEvent).to === 'completed')
    const missed = a.events.slice(a.events.indexOf(started) + 1).map((e) => e.id)
    expect(missed.length).toBeGreaterThan(2)
    const last = missed.at(-1)!

    const b = await stream({ lastEventId: started.id })
    await b.until((e) => e.id === last)
    expect(b.events.map((e) => e.id)).toEqual(missed)

    const c = await stream({ query: `?lastEventId=${encodeURIComponent(started.id)}` })
    await c.until((e) => e.id === last)
    expect(c.events.map((e) => e.id)).toEqual(missed)
  })

  it('prefers the header over the query', async () => {
    s = await startTestServer()
    await s.api('POST', '/api/agents', nova)
    const state = (await s.api('GET', '/api/state')).body
    const x = await stream({ lastEventId: state.lastEventId, query: '?lastEventId=nonsense' })
    await s.api('POST', '/api/agents', { ...nova, name: 'Quill' })
    const first = await x.next()
    expect(first.type).toBe('state.changed')
  })

  it('sends only live events without an id', async () => {
    s = await startTestServer()
    await s.api('POST', '/api/agents', nova)
    const x = await stream()
    await new Promise((r) => setTimeout(r, 50))
    expect(x.events).toEqual([])
  })

  it('sends state.reset for an id from another boot', async () => {
    s = await startTestServer()
    const x = await stream({ lastEventId: 'other:1' })
    const e = await x.next()
    const state = (await s.api('GET', '/api/state')).body
    expect(e).toMatchObject({ type: 'state.reset', reason: 'gap', id: state.lastEventId })
  })

  it('sends state.reset when the id is older than the buffer', async () => {
    s = await startTestServer({ EVENT_BUFFER_SIZE: '3' })
    for (let i = 0; i < 5; i++) await s.api('POST', '/api/agents', { ...nova, name: `Nova ${i}` })
    const boot = s.app.events.bootId
    const x = await stream({ lastEventId: `${boot}:1` })
    expect((await x.next()).type).toBe('state.reset')
  })

  it('sends state.reset for an id ahead of the server', async () => {
    s = await startTestServer()
    const x = await stream({ lastEventId: `${s.app.events.bootId}:999` })
    expect((await x.next()).type).toBe('state.reset')
  })

  it('carries the configured response headers', async () => {
    s = await startTestServer({}, { responseHeaders: () => ({ 'x-test': 'yes' }) })
    const x = await stream()
    expect(x.response.headers.get('x-test')).toBe('yes')
  })

  it('closing the server ends open streams', async () => {
    s = await startTestServer()
    await stream()
    const closed = await Promise.race([s.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('timeout'), 1000))])
    expect(closed).toBe('closed')
  })
})

describe('stream limits and CORS', () => {
  it('SSE gets CORS headers for an allowed origin', async () => {
    s = await startTestServer()
    const x = await stream({ headers: { origin: 'http://localhost:5173' } })
    expect(x.response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(x.response.headers.get('x-request-id')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('limits open event streams', async () => {
    s = await startTestServer({}, { maxStreams: 2 })
    const first = await stream()
    await stream()
    const third = await fetch(`${s.url}/api/events`)
    expect(third.status).toBe(503)
    expect(await third.json()).toEqual({ error: 'Too many open event streams (limit 2).' })
    first.close()
    await poll(() => s!.app.streams.size < 2)
    const again = await fetch(`${s.url}/api/events`)
    expect(again.status).toBe(200)
    await again.body?.cancel()
  })

  it('ends a stream whose buffer passes the limit', () => {
    const events = new EventLog({ capacity: 10, now: () => '2026-10-31T09:00:00.000Z', bootId: 'b', log: silentLogger })
    const streams = new Set<ServerResponse>()
    const warn = vi.fn()
    const route = eventsRoute({ events, heartbeatMs: 60000, streams, now: () => 'x', log: { ...silentLogger, warn }, maxBufferBytes: 10 })
    const req = Object.assign(new EventEmitter(), { headers: {} })
    const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn(() => false), writableLength: 11, end: vi.fn() })
    void route.handler({ req: req as never, res: res as never, url: new URL('http://x/api/events'), params: {}, body: undefined, requestId: 'r' })
    expect(res.end).toHaveBeenCalled()
    expect(streams.size).toBe(0)
    expect(warn).toHaveBeenCalledWith('Closed a slow event stream (over 1 MB buffered).')
    expect(events.listenerCount()).toBe(0)
  })
})

