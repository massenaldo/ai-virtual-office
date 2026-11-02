import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_FILE, type AuditRecord } from './audit'
import { PERMISSIONS_FILE } from './permissions/store'
import { parsePermissions } from './permissions/storage'
import type { PermissionChangedEvent } from '../src/workforce/api'
import { openEventStream, type SseStream } from './test/sseClient'
import { startTestServer, tempDataDir, type TestServer } from './test/helpers'
import { makeWorkspaceRoot } from './test/workspaces'

// The permission rules in the whole server: the real app on a real port, the mock runtime and a real workspace, driven only
// through HTTP and the event stream. Revoking goes through the store until stage C adds the endpoint.

let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
const streams: SseStream[] = []
afterEach(async () => { streams.splice(0).forEach((x) => x.close()); vi.useRealTimers(); await s?.close(); s = null; ws?.cleanup(); ws = null })

const TIMINGS = { thinkingMs: 50, workingMs: 20000 }
const readAudit = (t: TestServer): AuditRecord[] => readFileSync(join(t.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord)
const state = async (t: TestServer) => (await t.api('GET', '/api/state')).body.state
const task = async (t: TestServer, id: string) => (await state(t)).tasks.find((x: { id: string }) => x.id === id)
async function until(fn: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function start(env: Record<string, string> = {}) {
  ws = makeWorkspaceRoot(['sandbox'])
  s = await startTestServer({ ...ws.env, ...env }, { mockTimings: TIMINGS })
  const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Build API', workspaceId: 'sandbox' })
  const id = started.body.task.id as string
  await until(async () => (await task(s!, id)).status === 'running')
  return id
}
const askDemoWrite = async (id: string) => { await s!.api('POST', `/api/demo/tasks/${id}/request-approval`); await until(async () => (await task(s!, id)).status === 'waiting_for_approval') }

describe('permission rules in the running server', () => {
  it('writes permissions.json with the defaults at start', async () => {
    await start()
    const rules = parsePermissions(JSON.parse(readFileSync(join(s!.dataDir, PERMISSIONS_FILE), 'utf8')))
    expect(rules?.map((r) => r.id)).toContain('default-write')
    expect(s!.app.permissions.rules).toHaveLength(8)
  })

  it('allow for this task over HTTP: audited grant, decision and use, then no prompt for the next request', async () => {
    const id = await start()
    const stream = await openEventStream(s!.url, { token: s!.app.apiToken.value })
    streams.push(stream)
    await askDemoWrite(id)
    const pending = (await task(s!, id)).pendingApproval
    const decided = await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'allow_task', digest: pending.digest })
    expect(decided.status).toBe(200)
    await until(async () => (await task(s!, id)).status === 'running')

    await s!.api('POST', `/api/demo/tasks/${id}/request-approval`)
    await new Promise((r) => setTimeout(r, 200))
    expect((await task(s!, id)).status).toBe('running')

    const audit = readAudit(s!).filter((r) => r.taskId === id || r.action === 'permission.granted')
    const granted = audit.find((r) => r.action === 'permission.granted')!
    const decision = audit.find((r) => r.action === 'approval.decided')!
    expect(granted).toMatchObject({ tool: 'Write', agentId: 'agent-demo-backend', reason: 'task', detail: 'allow' })
    expect(decision).toMatchObject({ decision: 'allow_task', ruleId: granted.ruleId, digest: pending.digest.slice(0, 12), actionHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const used = audit.filter((r) => r.action === 'permission.used')
    expect(used).toHaveLength(2)
    expect(used[1]).toMatchObject({ ruleId: granted.ruleId, tool: 'Write' })
    expect(audit.filter((r) => r.action === 'approval.requested')).toHaveLength(1)

    const seen = stream.events.map((e) => e.type)
    expect(seen).toContain('task.waiting_for_approval')
  })

  it('a revoke through the store makes the next request ask again, and is audited', async () => {
    const id = await start()
    await askDemoWrite(id)
    const pending = (await task(s!, id)).pendingApproval
    await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'allow_agent', digest: pending.digest })
    await until(async () => (await task(s!, id)).status === 'running')
    const rule = s!.app.permissions.rules.find((r) => r.scope === 'agent')!
    expect(s!.app.permissions.revoke(rule.id).ok).toBe(true)
    await askDemoWrite(id)
    expect(readAudit(s!).find((r) => r.action === 'permission.revoked')).toMatchObject({ ruleId: rule.id, tool: 'Write' })
  })

  it('audits an expired rule once, from the sweep', async () => {
    await start()
    const soon = new Date(Date.now() + 150).toISOString()
    const rule = s!.app.permissions.grant({ scope: 'agent', effect: 'allow', tool: 'Edit', agentId: 'agent-demo-backend', expiresAt: soon })
    expect(rule.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 250))
    s!.app.permissions.sweep()
    s!.app.permissions.sweep()
    expect(readAudit(s!).filter((r) => r.action === 'permission.expired')).toHaveLength(1)
  })

  it('stops its expiry sweep when the server closes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await start()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await s!.close()
    s = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not allow more than the defaults when permissions.json is damaged', async () => {
    const dir = tempDataDir()
    writeFileSync(join(dir, PERMISSIONS_FILE), '{ not json')
    ws = makeWorkspaceRoot(['sandbox'])
    s = await startTestServer({ ...ws.env, DATA_DIR: dir }, { mockTimings: TIMINGS })
    expect(s.app.permissions.load.problem).toBe('corrupt')
    expect(s.app.permissions.rules.every((r) => r.createdBy === 'default')).toBe(true)
    const started = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'T', workspaceId: 'sandbox' })
    const id = started.body.task.id as string
    await until(async () => (await task(s!, id)).status === 'running')
    await askDemoWrite(id)
  })
})

describe('permission changes over the event stream', () => {
  const permissionEvents = (x: SseStream) => x.events.filter((e) => e.type === 'permission.changed') as PermissionChangedEvent[]

  it('a POST then a DELETE over HTTP are streamed as granted and revoked, in order, with the rule state', async () => {
    await start()
    const stream = await openEventStream(s!.url, { token: s!.app.apiToken.value })
    streams.push(stream)
    const made = await s!.api('POST', '/api/permissions', { scope: 'global', effect: 'deny', tool: 'Grep' })
    const granted = await stream.next((e) => e.type === 'permission.changed') as PermissionChangedEvent
    expect(granted).toMatchObject({ kind: 'granted', rule: { id: made.body.rule.id, state: 'active', effect: 'deny' } })
    await s!.api('DELETE', `/api/permissions/${made.body.rule.id}`)
    const revoked = await stream.next((e) => e.type === 'permission.changed') as PermissionChangedEvent
    expect(revoked).toMatchObject({ kind: 'revoked', rule: { id: made.body.rule.id, state: 'revoked' } })
    expect(Number(revoked.id.split(':')[1])).toBeGreaterThan(Number(granted.id.split(':')[1]))
    expect(JSON.stringify(permissionEvents(stream))).not.toContain('digest')
  })

  it('a client that resumes with its last event id gets the missed permission events in order', async () => {
    await start()
    const first = await openEventStream(s!.url, { token: s!.app.apiToken.value })
    streams.push(first)
    const a = await s!.api('POST', '/api/permissions', { scope: 'global', effect: 'deny', tool: 'Grep' })
    const seen = await first.next((e) => e.type === 'permission.changed')
    first.close()
    await s!.api('DELETE', `/api/permissions/${a.body.rule.id}`)
    await s!.api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Glob' })
    const resumed = await openEventStream(s!.url, { token: s!.app.apiToken.value, lastEventId: seen.id })
    streams.push(resumed)
    const got = await resumed.until((e) => e.type === 'permission.changed' && (e as PermissionChangedEvent).kind === 'granted')
    // The mock task may report progress in between; only the permission events matter here.
    expect(got.filter((e) => e.type === 'permission.changed').map((e) => (e as PermissionChangedEvent).kind)).toEqual(['revoked', 'granted'])
  })

  it('the grant and the use of a one-time permission are streamed', async () => {
    const id = await start()
    const stream = await openEventStream(s!.url, { token: s!.app.apiToken.value })
    streams.push(stream)
    await askDemoWrite(id)
    const pending = (await task(s!, id)).pendingApproval
    await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'allow_once', digest: pending.digest })
    const kinds: string[] = []
    await stream.until((e) => { if (e.type === 'permission.changed') kinds.push((e as PermissionChangedEvent).kind); return kinds.includes('used') })
    expect(kinds).toEqual(['granted', 'used'])
  })
})
