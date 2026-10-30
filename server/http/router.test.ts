import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log'
import { createRouter, type RouterOptions, type Route } from './router'

let server: Server | null = null
afterEach(async () => { await new Promise((r) => (server ? server.close(() => r(null)) : r(null))); server = null })

const routes: Route[] = [
  { method: 'POST', path: '/echo', body: 'json', handler: ({ body }) => ({ status: 200, body }) },
  { method: 'GET', path: '/items/:id', handler: ({ params }) => ({ status: 200, body: params }) },
  { method: 'GET', path: '/boom', handler: () => { throw new Error('secret stack') } },
]

async function start(extra: Partial<RouterOptions> = {}): Promise<string> {
  server = createServer(createRouter({ routes, log: silentLogger, ...extra }))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (url: string, body: string, type = 'application/json') => fetch(`${url}/echo`, { method: 'POST', headers: { 'content-type': type }, body })

describe('createRouter', () => {
  it('matches params', async () => {
    const url = await start()
    const res = await fetch(`${url}/items/a%20b`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'a b' })
  })

  it('404 for an unknown path', async () => {
    const res = await fetch(`${await start()}/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found.' })
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('405 with Allow for a known path', async () => {
    const res = await fetch(`${await start()}/items/1`, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    expect(await res.json()).toEqual({ error: 'Method not allowed.' })
  })

  it('400 for a malformed escape in the path', async () => {
    const res = await fetch(`${await start()}/items/%E0%A4%A`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid URL.' })
  })

  it('415 without a JSON content type', async () => {
    const res = await post(await start(), '{}', 'text/plain')
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type must be application/json.' })
  })

  it('accepts a JSON content type with parameters', async () => {
    const res = await post(await start(), '{"a":1}', 'application/json; charset=utf-8')
    expect(await res.json()).toEqual({ a: 1 })
  })

  it('413 for a body over 64 KB', async () => {
    const res = await post(await start(), JSON.stringify({ big: 'x'.repeat(70000) }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Request body is too large (limit 64 KB).' })
  })

  it('400 for invalid JSON and for a JSON array', async () => {
    const url = await start()
    const bad = await post(url, '{nope')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Request body is not valid JSON.' })
    const arr = await post(url, '[1]')
    expect(arr.status).toBe(400)
    expect(await arr.json()).toEqual({ error: 'Request body must be a JSON object.' })
  })

  it('echoes a valid JSON object and treats an empty body as {}', async () => {
    const url = await start()
    expect(await (await post(url, '{"title":"x"}')).json()).toEqual({ title: 'x' })
    expect(await (await post(url, '')).json()).toEqual({})
  })

  it('500 hides the error', async () => {
    const res = await fetch(`${await start()}/boom`)
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error.' })
    expect(text).not.toContain('secret stack')
  })

  it('a guard short-circuits every route', async () => {
    const url = await start({ guards: [() => ({ status: 403, body: { error: 'Blocked.' } })] })
    const res = await fetch(`${url}/items/1`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Blocked.' })
  })

  it('responseHeaders are added to every reply', async () => {
    const url = await start({ responseHeaders: () => ({ 'x-test': 'yes' }) })
    expect((await fetch(`${url}/items/1`)).headers.get('x-test')).toBe('yes')
    expect((await fetch(`${url}/nope`)).headers.get('x-test')).toBe('yes')
  })
})
