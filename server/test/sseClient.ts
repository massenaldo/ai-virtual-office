import { TEST_TOKEN } from './helpers'
import type { WorkforceEvent } from '../../src/workforce/api'

export type SseStream = {
  events: WorkforceEvent[]
  comments: string[]
  /** Raw text chunks as they arrived. */
  raw: string[]
  /** The first matching event at or after the cursor; the cursor moves past it. */
  next(match?: (e: WorkforceEvent) => boolean, timeoutMs?: number): Promise<WorkforceEvent>
  /** Every event from the cursor through the first match; the cursor moves past it. */
  until(match: (e: WorkforceEvent) => boolean, timeoutMs?: number): Promise<WorkforceEvent[]>
  close(): void
}

/** A fetch-based SSE reader for tests: parses id/event/data frames and ':' comments. */
export async function openEventStream(baseUrl: string, opts: { lastEventId?: string; query?: string; headers?: Record<string, string>; token?: string } = {}): Promise<SseStream & { response: Response }> {
  const abort = new AbortController()
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token ?? TEST_TOKEN}`, ...(opts.lastEventId === undefined ? {} : { 'Last-Event-ID': opts.lastEventId }), ...(opts.headers ?? {}) }
  const response = await fetch(`${baseUrl}/api/events${opts.query ?? ''}`, { headers, signal: abort.signal })
  const events: WorkforceEvent[] = []
  const comments: string[] = []
  const raw: string[] = []
  const waiters = new Set<() => void>()
  let cursor = 0

  const frame = (text: string) => {
    const data: string[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1))
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length > 0) events.push(JSON.parse(data.join('\n')) as WorkforceEvent)
  }

  void (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        raw.push(chunk)
        buffer += chunk
        for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
          frame(buffer.slice(0, cut))
          buffer = buffer.slice(cut + 2)
        }
        for (const wake of [...waiters]) wake()
      }
    } catch {
      // Aborted by close(), or the server ended the stream.
    }
  })()

  function wait<T>(find: () => T | undefined, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const found = find()
        if (found === undefined) return false
        waiters.delete(attempt)
        clearTimeout(timer)
        resolve(found)
        return true
      }
      const timer = setTimeout(() => {
        waiters.delete(attempt)
        reject(new Error(`No matching event within ${timeoutMs} ms; saw: ${events.map((e) => e.type).join(', ') || 'nothing'}`))
      }, timeoutMs)
      if (!attempt()) waiters.add(attempt)
    })
  }

  return {
    response, events, comments, raw,
    next: (match = () => true, timeoutMs = 2000) => wait(() => {
      const i = events.findIndex((e, n) => n >= cursor && match(e))
      if (i < 0) return undefined
      cursor = i + 1
      return events[i]
    }, timeoutMs),
    until: (match, timeoutMs = 2000) => wait(() => {
      const i = events.findIndex((e, n) => n >= cursor && match(e))
      if (i < 0) return undefined
      const slice = events.slice(cursor, i + 1)
      cursor = i + 1
      return slice
    }, timeoutMs),
    close: () => abort.abort(),
  }
}
