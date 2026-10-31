import { describe, expect, it, vi } from 'vitest'
import { createApiGate, type GateRequest } from './apiProxy'

const TOKEN = 'proxy-token-0123456789-abcdefghijklmnopqrstuvwxyz'

function run(url: string, headers: Record<string, string>, token: string | null = TOKEN) {
  const req: GateRequest = { url, headers: { ...headers } }
  const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader(k: string, v: string) { this.headers[k] = v }, end(b?: string) { this.body = b ?? '' } }
  const next = vi.fn()
  createApiGate({ readToken: () => token })(req, res, next)
  return { req, res, next }
}
const SAME = { 'sec-fetch-site': 'same-origin' }

describe('createApiGate', () => {
  it('adds the bearer token for a same-origin request and passes it on', () => {
    const { req, res, next } = run('/api/state', SAME)
    expect(next).toHaveBeenCalledOnce()
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(res.statusCode).toBe(200)
  })

  it('replaces an incoming Authorization and removes cookies', () => {
    const { req } = run('/api/events?lastEventId=b1%3A5', { ...SAME, authorization: 'Bearer attacker', cookie: 'a=b', Cookie: 'c=d' })
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(req.headers.cookie).toBeUndefined()
    expect(req.headers.Cookie).toBeUndefined()
  })

  it.each<Record<string, string>>([{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }])('refuses %j with 403 and does not forward', (headers) => {
    const { res, next } = run('/api/state', headers)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'The dev proxy only serves same-origin requests from this app.' })
  })

  it('does not touch anything outside /api/', () => {
    for (const url of ['/', '/src/main.tsx', '/apix', '/@vite/client']) {
      const { req, next } = run(url, { authorization: 'keep', cookie: 'keep' })
      expect(next).toHaveBeenCalledOnce()
      expect(req.headers).toEqual({ authorization: 'keep', cookie: 'keep' })
    }
  })

  it('answers 503 when no token is available, without forwarding', () => {
    const { res, next } = run('/api/state', SAME, null)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toEqual({ error: 'The backend token is not available. Is the backend running?' })
  })

  it('reads the token on every request, so a restart is picked up', () => {
    const read = vi.fn().mockReturnValueOnce('first-token-0123456789-abcdefghijklmnop').mockReturnValueOnce('second-token-0123456789-abcdefghijklmno')
    const gate = createApiGate({ readToken: read })
    const a: GateRequest = { url: '/api/state', headers: { ...SAME } }
    const b: GateRequest = { url: '/api/state', headers: { ...SAME } }
    const res = () => ({ statusCode: 200, setHeader() {}, end() {} })
    gate(a, res(), () => {})
    gate(b, res(), () => {})
    expect([a.headers.authorization, b.headers.authorization]).toEqual(['Bearer first-token-0123456789-abcdefghijklmnop', 'Bearer second-token-0123456789-abcdefghijklmno'])
  })
})
