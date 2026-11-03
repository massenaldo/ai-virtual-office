import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PermissionChangedEvent, PermissionRuleView, WorkforceEvent } from '../../src/workforce/api'
import { startServer, type RunningServer } from '../app'
import { AUDIT_FILE } from '../audit'
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
const state = async () => (await call('GET', '/api/state')).body.state as { agents: Array<{ id: string; status: string }>; tasks: Array<{ id: string; agentId: string; status: string; pendingApproval: { id: string; tool: string; digest: string | null } | null }> }
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
    const waitingEvents = await stream.until((e) => e.type === 'task.waiting_for_approval')
    const patched = (waitingEvents.at(-1) as { patch: { tasks: Array<{ id: string; pendingApproval: { digest: string; review: { kind: string } } | null }> } }).patch.tasks.find((t) => t.id === forgeTask)
    expect(patched?.pendingApproval?.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(patched?.pendingApproval?.review.kind).toBe('write')
    const task = (await state()).tasks.find((t) => t.id === forgeTask)!
    expect(task).toMatchObject({ status: 'waiting_for_approval', pendingApproval: { tool: 'Write' } })
    expect(task.pendingApproval!.digest).toMatch(/^[0-9a-f]{64}$/)
    const wrong = await call('POST', `/api/tasks/${forgeTask}/approval`, { body: { approvalId: task.pendingApproval!.id, decision: 'approve', digest: '0'.repeat(64) } })
    expect(wrong.status).toBe(409)
    expect((await call('POST', `/api/tasks/${forgeTask}/approval`, { body: { approvalId: task.pendingApproval!.id, decision: 'approve' } })).status).toBe(409)
    expect((await call('POST', `/api/tasks/${forgeTask}/approval`, { body: { approvalId: task.pendingApproval!.id, decision: 'approve', digest: task.pendingApproval!.digest } })).status).toBe(200)
    await stream.until((e) => e.type === 'task.completed', 5000)
    expect((await state()).tasks.find((t) => t.id === forgeTask)!.status).toBe('completed')
    // The audit log tells the same story the stream did: the gate asked about the Write, a person decided, nothing went stale.
    const audit = readFileSync(join(dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.taskId === forgeTask)
    expect(audit.find((r) => r.action === 'tool.asked')).toMatchObject({ tool: 'Write', decision: 'ask', detail: 'Write simulated.txt (39 B, 1 line): review the full content' })
    expect(audit.find((r) => r.action === 'approval.decided')).toMatchObject({ decision: 'approve' })
    expect(audit.map((r) => r.action)).not.toContain('tool.stale')
    // The mock's perform writes nothing.
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

describe('permissions, end to end', () => {
  const permEvents = (events: WorkforceEvent[]) => events.filter((e): e is PermissionChangedEvent => e.type === 'permission.changed')
  const rules = async (path = '/api/permissions') => (await call('GET', path)).body.rules as PermissionRuleView[]
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const taskOf = async (id: string) => (await state()).tasks.find((t) => t.id === id)!
  async function untilTask(id: string, ok: (t: Awaited<ReturnType<typeof taskOf>>) => boolean) {
    for (let i = 0; i < 100; i++) { if (ok(await taskOf(id))) return; await pause(50) }
    throw new Error(`task ${id} never reached the expected state`)
  }
  async function startTask(): Promise<string> {
    const r = await call('POST', `/api/agents/${FORGE}/tasks`, { body: { title: 'Perm', workspaceId: 'sandbox' } })
    expect(r.status).toBe(202)
    const id = r.body.task.id as string
    await untilTask(id, (t) => t.status === 'running')
    return id
  }
  async function askWrite(id: string) {
    await call('POST', `/api/demo/tasks/${id}/request-approval`)
    await untilTask(id, (t) => t.status === 'waiting_for_approval')
    return (await taskOf(id)).pendingApproval!
  }
  const decide = (id: string, p: { id: string; digest: string | null }, decision: string) =>
    call('POST', `/api/tasks/${id}/approval`, { body: { approvalId: p.id, decision, digest: p.digest } })
  const finish = async (id: string) => { await call('POST', `/api/tasks/${id}/cancel`); await untilTask(id, (t) => t.status === 'cancelled' || t.status === 'completed') }
  const seen: WorkforceEvent[] = []
  let stream: SseStream
  const drain = () => { seen.push(...stream.events.slice(seen.length)) }

  it('streams a global grant and its revoke in order, and the lists agree with the events', async () => {
    stream = await open()
    const made = await call('POST', '/api/permissions', { body: { scope: 'global', effect: 'deny', tool: 'Grep' } })
    expect(made.status).toBe(201)
    const granted = (await stream.next((e) => e.type === 'permission.changed')) as PermissionChangedEvent
    expect(granted).toMatchObject({ kind: 'granted', rule: { id: made.body.rule.id, scope: 'global', effect: 'deny', state: 'active' } })
    expect((await rules()).find((r) => r.id === granted.rule.id)).toEqual(granted.rule)
    expect((await call('DELETE', `/api/permissions/${granted.rule.id}`)).status).toBe(200)
    const revoked = (await stream.next((e) => e.type === 'permission.changed')) as PermissionChangedEvent
    expect(revoked).toMatchObject({ kind: 'revoked', rule: { id: granted.rule.id, state: 'revoked' } })
    expect(seqOf(revoked)).toBeGreaterThan(seqOf(granted))
    expect((await rules()).some((r) => r.id === granted.rule.id)).toBe(false)
    expect((await rules('/api/permissions/history')).find((r) => r.id === granted.rule.id)).toEqual(revoked.rule)
    expect((await call('DELETE', `/api/permissions/${granted.rule.id}`)).status).toBe(409)
    drain()
  })

  it('refuses to allow Bash for everyone, and an unknown agent, creating no rule', async () => {
    const before = await rules()
    expect((await call('POST', '/api/permissions', { body: { scope: 'global', effect: 'allow', tool: 'Bash' } })).status).toBeGreaterThanOrEqual(400)
    expect((await call('POST', '/api/permissions', { body: { scope: 'agent', agentId: FORGE, effect: 'allow', tool: 'Bash' } })).status).toBeGreaterThanOrEqual(400)
    expect((await call('POST', '/api/permissions', { body: { scope: 'agent', agentId: 'nobody', effect: 'deny', tool: 'Grep' } })).status).toBe(404)
    expect(await rules()).toEqual(before)
  })

  it('allow_task: the same task is not asked again; revoking the rule makes it ask again', async () => {
    const id = await startTask()
    const first = await askWrite(id)
    expect((await decide(id, first, 'allow_task')).status).toBe(200)
    const granted = (await stream.next((e) => e.type === 'permission.changed' && (e as PermissionChangedEvent).kind === 'granted')) as PermissionChangedEvent
    expect(granted.rule).toMatchObject({ scope: 'task', effect: 'allow', tool: 'Write', taskId: id })
    await untilTask(id, (t) => t.status === 'running')
    await call('POST', `/api/demo/tasks/${id}/request-approval`)
    await pause(150)
    expect((await taskOf(id)).status).not.toBe('waiting_for_approval')
    expect((await call('DELETE', `/api/permissions/${granted.rule.id}`)).status).toBe(200)
    await stream.next((e) => e.type === 'permission.changed' && (e as PermissionChangedEvent).kind === 'revoked')
    await askWrite(id)
    await finish(id)
    drain()
  })

  it('allow_once: granted, then used, then in history', async () => {
    const id = await startTask()
    const p = await askWrite(id)
    expect((await decide(id, p, 'allow_once')).status).toBe(200)
    const got = permEvents(await stream.until((e) => e.type === 'permission.changed' && (e as PermissionChangedEvent).kind === 'used'))
      .filter((e) => e.rule.scope === 'once')
    expect(got.map((e) => e.kind)).toEqual(['granted', 'used'])
    expect((await rules('/api/permissions/history')).some((r) => r.id === got[0].rule.id)).toBe(true)
    await finish(id)
    drain()
  })

  it('never puts a digest in a permission event', () => {
    drain()
    const all = permEvents(seen)
    expect(all.length).toBeGreaterThanOrEqual(6)
    expect(JSON.stringify(all)).not.toMatch(/digest|[0-9a-f]{64}/)
  })

  it('replays the permission events a client missed, in order; an unknown boot gets state.reset', async () => {
    const made = await call('POST', '/api/permissions', { body: { scope: 'global', effect: 'ask', tool: 'Glob' } })
    const granted = (await stream.next((e) => e.type === 'permission.changed')) as PermissionChangedEvent
    stream.close()
    await call('DELETE', `/api/permissions/${made.body.rule.id}`)
    const again = await call('POST', '/api/permissions', { body: { scope: 'global', effect: 'ask', tool: 'Glob' } })
    expect(again.status).toBe(201)
    const resumed = await open({ lastEventId: granted.id })
    const got = permEvents(await resumed.until((e) => e.type === 'permission.changed' && (e as PermissionChangedEvent).kind === 'granted'))
    expect(got.map((e) => e.kind)).toEqual(['revoked', 'granted'])
    expect(got[0].rule.id).toBe(made.body.rule.id)
    expect((await (await open({ lastEventId: 'oldboot:5' })).next()).type).toBe('state.reset')
  })
})
