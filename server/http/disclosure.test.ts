import { homedir, tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { recordingLogger } from '../log'
import { rawRequest, startTestServer, TEST_TOKEN, type TestServer } from '../test/helpers'
import { makeWorkspaceRoot } from '../test/workspaces'

// Everything the server sends back, on every path an unauthenticated or hostile client can reach, must stay free of
// absolute paths, the token and internals (stack frames, error class names).

let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
afterEach(async () => { await s?.close(); s = null; ws?.cleanup(); ws = null })

describe('what an error or open response may contain', () => {
  it('has no path, token or internals in any response', async () => {
    ws = makeWorkspaceRoot(['sandbox'])
    const log = recordingLogger()
    let boom = false
    s = await startTestServer(ws.env, {
      log,
      mockTimings: { thinkingMs: 60000, workingMs: 60000 },
      guards: [() => { if (boom) throw new Error(`Cannot open ${s!.dataDir}/secret ${ws!.root}`); return null }],
    })
    const json = { 'content-type': 'application/json' }
    const req = (opts: Parameters<typeof rawRequest>[1]) => rawRequest(s!.url, opts)
    await req({ method: 'POST', path: '/api/agents/agent-demo-backend/tasks', headers: json, body: '{"title":"x","workspaceId":"sandbox"}' })

    const cases: Array<[string, number, Promise<{ status: number; headers: Record<string, unknown>; body: string }>]> = [
      ['health', 200, req({ path: '/api/health', noAuth: true })],
      ['preflight', 204, req({ method: 'OPTIONS', path: '/api/state', noAuth: true, headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } })],
      ['401 none', 401, req({ path: '/api/state', noAuth: true })],
      ['401 wrong', 401, req({ path: '/api/state', noAuth: true, headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' } })],
      ['404', 404, req({ path: '/api/nope' })],
      ['405', 405, req({ method: 'PUT', path: '/api/state', headers: json })],
      ['421', 421, req({ path: '/api/state', headers: { host: 'evil.example' } })],
      ['403', 403, req({ path: '/api/state', headers: { origin: 'http://evil.example' } })],
      ['415', 415, req({ method: 'POST', path: '/api/agents', headers: { 'content-type': 'text/plain' }, body: '{}' })],
      ['400 json', 400, req({ method: 'POST', path: '/api/agents', headers: json, body: '{' })],
      ['400 workspace', 400, req({ method: 'POST', path: '/api/agents/agent-demo-pm/tasks', headers: json, body: '{"title":"x","workspaceId":"../x"}' })],
      ['413', 413, req({ method: 'POST', path: '/api/agents', headers: json, body: JSON.stringify({ name: 'a'.repeat(70000) }) })],
      ['422', 422, req({ method: 'POST', path: '/api/agents/agent-demo-pm/tasks', headers: json, body: '{"title":"x","workspaceId":"nope"}' })],
      ['409', 409, req({ method: 'POST', path: '/api/agents/agent-demo-backend/tasks', headers: json, body: '{"title":"again","workspaceId":"sandbox"}' })],
    ]
    const replies = await Promise.all(cases.map(async ([name, status, p]) => ({ name, status, reply: await p })))
    boom = true
    replies.push({ name: '500', status: 500, reply: await req({ path: '/api/state' }) })
    boom = false

    const forbidden = [s.dataDir, ws.root, process.cwd(), homedir(), tmpdir(), TEST_TOKEN]
    for (const { name, status, reply } of replies) {
      expect(reply.status, name).toBe(status)
      const text = `${reply.body}\n${JSON.stringify(reply.headers)}`
      for (const bad of forbidden) expect(text, `${name} contains ${bad}`).not.toContain(bad)
      expect(text, name).not.toMatch(/"stack"|\n\s+at |Error:/)
    }
    expect(JSON.parse(replies.find((r) => r.name === '500')!.reply.body)).toEqual({ error: 'Internal server error.' })
  })

  it('never logs a query string, so a token in a URL cannot reach the log', async () => {
    const log = recordingLogger()
    let boom = true
    s = await startTestServer({}, { log, guards: [() => { if (boom) throw new Error('boom'); return null }] })
    await rawRequest(s.url, { path: `/api/state?token=${TEST_TOKEN}&lastEventId=b1:2` })
    boom = false
    const text = log.lines.join('\n')
    expect(text).toContain('Unhandled error on GET /api/state')
    expect(text).not.toContain(TEST_TOKEN)
    expect(text).not.toContain('lastEventId')
  })
})
