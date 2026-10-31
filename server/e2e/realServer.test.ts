import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkforceEvent } from '../../src/workforce/api'
import { startServer, type RunningServer } from '../app'
import { TOKEN_FILE } from '../auth'
import { parseConfig } from '../config'
import { silentLogger } from '../log'
import { openEventStream, type SseStream } from '../test/sseClient'
import { makeWorkspaceRoot } from '../test/workspaces'
import { tempDataDir } from '../test/helpers'

// A real end-to-end run: the real server on a real port, driven only through real HTTP and a real event stream, the way
// a browser or curl would. No fakes and no calls into the task manager. The only shortcut is the mock runtime's speed.

const FORGE = 'agent-demo-backend'
const PM = 'agent-demo-pm'
let ws: ReturnType<typeof makeWorkspaceRoot>
let dataDir: string
let server: RunningServer
let token: string
const streams: SseStream[] = []

beforeAll(async () => {
  ws = makeWorkspaceRoot(['sandbox'])
  dataDir = tempDataDir()
  const parsed = parseConfig({ PORT: '0', DATA_DIR: dataDir, ...ws.env })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  server = await startServer(parsed.config, { log: silentLogger, mockTimings: { thinkingMs: 50, workingMs: 1500 } })
  // A client learns the generated token the way the dev proxy does: from the file the server wrote.
  token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
})
afterAll(async () => {
  streams.splice(0).forEach((x) => x.close())
  await server.close()
  ws.cleanup()
})

type Reply = { status: number; body: any; headers: Headers }
async function call(method: string, path: string, opts: { body?: unknown; auth?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...opts.headers }
  const auth = opts.auth === undefined ? token : opts.auth
  if (auth !== null) headers.authorization = `Bearer ${auth}`
  const res = await fetch(`${server.url}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let body: unknown = text
  try { body = text === '' ? null : JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers }
}
const state = async () => (await call('GET', '/api/state')).body.state as { agents: Array<{ id: string; status: string }>; tasks: Array<{ id: string; agentId: string; status: string; pendingApproval: { id: string; tool: string } | null }> }
const open = async (opts?: Parameters<typeof openEventStream>[1]) => {
  const x = await openEventStream(server.url, { token, ...opts })
  streams.push(x)
  return x
}
const seqOf = (e: WorkforceEvent) => Number(e.id.slice(e.id.lastIndexOf(':') + 1))
const types = (events: WorkforceEvent[]) => events.map((e) => e.type)

describe('the real server, end to end', () => {
  let stream: SseStream
  let forgeTask = ''
  let pmTask = ''

  it('answers the health check without a token and refuses everything else without one', async () => {
    expect((await call('GET', '/api/health', { auth: null })).status).toBe(200)
    expect((await call('GET', '/api/state', { auth: null })).status).toBe(401)
    expect((await call('GET', '/api/state')).status).toBe(200)
  })

  it('refuses unauthorized mutations and event streams, with and without an Origin', async () => {
    for (const headers of [{}, { origin: 'http://localhost:5173' }] as Array<Record<string, string>>) {
      expect((await call('POST', '/api/agents', { auth: null, headers, body: { name: 'Nova', role: 'R', department: 'backend' } })).status).toBe(401)
      expect((await call('POST', `/api/agents/${FORGE}/tasks`, { auth: 'wrong-token-wrong-token-wrong-token-000', headers, body: { title: 'x' } })).status).toBe(401)
    }
    expect((await fetch(`${server.url}/api/events`)).status).toBe(401)
    expect((await fetch(`${server.url}/api/events?token=${token}`)).status).toBe(401)
    expect((await call('POST', '/api/agents', { headers: { origin: 'http://evil.example' }, body: { name: 'Nova', role: 'R', department: 'backend' } })).status).toBe(403)
    expect((await state()).agents).toHaveLength(6)
  })

  it('rejects bad workspaces and creates no task', async () => {
    expect((await call('POST', `/api/agents/${FORGE}/tasks`, { body: { title: 'x', workspaceId: '../x' } })).status).toBe(400)
    expect((await call('POST', `/api/agents/${FORGE}/tasks`, { body: { title: 'x', workspaceId: 'nope' } })).status).toBe(422)
    expect((await state()).tasks).toHaveLength(0)
  })

  it('streams queued, started and status events for a new task', async () => {
    stream = await open()
    const r = await call('POST', `/api/agents/${FORGE}/tasks`, { body: { title: 'Build API', workspaceId: 'sandbox' } })
    expect(r.status).toBe(202)
    forgeTask = r.body.task.id
    const seen = await stream.until((e) => e.type === 'task.started')
    expect(types(seen)).toEqual(expect.arrayContaining(['task.queued', 'agent.status_changed', 'task.started']))
    expect(seen.every((e, i) => i === 0 || seqOf(e) > seqOf(seen[i - 1]))).toBe(true)
  })

  it('takes the demo approval through the gate: waiting, approve, completed', async () => {
    expect((await call('POST', `/api/demo/tasks/${forgeTask}/request-approval`)).status).toBe(202)
    await stream.until((e) => e.type === 'task.waiting_for_approval')
    const task = (await state()).tasks.find((t) => t.id === forgeTask)!
    expect(task).toMatchObject({ status: 'waiting_for_approval', pendingApproval: { tool: 'Write' } })
    expect((await call('POST', `/api/tasks/${forgeTask}/approval`, { body: { approvalId: task.pendingApproval!.id, decision: 'approve' } })).status).toBe(200)
    await stream.until((e) => e.type === 'task.completed', 5000)
    expect((await state()).tasks.find((t) => t.id === forgeTask)!.status).toBe('completed')
    expect(readdirSync(ws.path('sandbox'))).toEqual([])
  })

  it('cancels a second task and agrees with the final state', async () => {
    const r = await call('POST', `/api/agents/${PM}/tasks`, { body: { title: 'Draft plan' } })
    expect(r.status).toBe(202)
    pmTask = r.body.task.id
    await stream.until((e) => e.type === 'task.started' && e.taskId === pmTask)
    expect((await call('POST', `/api/tasks/${pmTask}/cancel`)).status).toBe(202)
    await stream.until((e) => e.type === 'task.cancelled' && e.taskId === pmTask, 5000)
    const final = await state()
    expect(final.tasks.find((t) => t.id === pmTask)!.status).toBe('cancelled')
    expect(final.tasks.find((t) => t.id === forgeTask)!.status).toBe('completed')
    expect(final.agents.find((a) => a.id === PM)!.status).toBe('idle')
  })

  it('resumes with Last-Event-ID and sends only newer events; an old boot gets state.reset', async () => {
    const before = (await call('GET', '/api/state')).body.lastEventId as string
    stream.close()
    const created = await call('POST', '/api/agents', { body: { name: 'Nova', role: 'Researcher', department: 'backend' } })
    expect(created.status).toBe(201)
    const resumed = await open({ lastEventId: before })
    const first = await resumed.next()
    expect(first.type).not.toBe('state.reset')
    expect(seqOf(first)).toBeGreaterThan(Number(before.slice(before.lastIndexOf(':') + 1)))
    expect(first.id.split(':')[0]).toBe(before.split(':')[0])
    const stale = await open({ lastEventId: 'oldboot:5' })
    expect((await stale.next()).type).toBe('state.reset')
  })
})
