import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyWorkforceEvent, type ChangeEvent } from '../src/workforce/api'
import { parseWorkforce } from '../src/workforce/storage'
import { WORKFORCE_FILE } from './store'
import { openEventStream, type SseStream } from './test/sseClient'
import { startTestServer, type TestServer } from './test/helpers'

let s: TestServer
let x: SseStream
const FORGE = 'agent-demo-backend'

async function begin(env: Record<string, string> = {}, timings = { thinkingMs: 50, workingMs: 100 }) {
  s = await startTestServer(env, { mockTimings: timings })
  const snapshot = (await s.api('GET', '/api/state')).body
  x = await openEventStream(s.url, { query: `?lastEventId=${encodeURIComponent(snapshot.lastEventId)}` })
  return snapshot
}
afterEach(async () => { x?.close(); await s?.close() })

const state = async () => (await s.api('GET', '/api/state')).body
const startTask = async (title = 'Build API') => (await s.api('POST', `/api/agents/${FORGE}/tasks`, { title })).body.task.id as string
const typesFor = (taskId: string) => x.events.filter((e) => (e as ChangeEvent).taskId === taskId).map((e) => e.type)
const inOrder = (haystack: string[], needles: string[]) => {
  let from = 0
  for (const n of needles) {
    const i = haystack.indexOf(n, from)
    if (i < 0) return false
    from = i + 1
  }
  return true
}
const isType = (t: string) => (e: { type: string }) => e.type === t

describe('mock lifecycle over HTTP and SSE', () => {
  beforeEach(() => { /* each test starts its own server */ })

  it('start → completed', async () => {
    await begin()
    const id = await startTask()
    await x.until(isType('task.completed'))
    await x.until((e) => e.type === 'agent.status_changed' && (e as ChangeEvent).to === 'completed')
    expect(inOrder(typesFor(id), ['task.queued', 'task.started', 'task.progress', 'task.progress', 'task.completed', 'agent.status_changed'])).toBe(true)
    const task = (await state()).state.tasks[0]
    expect(task).toMatchObject({ status: 'completed', endedReason: 'completed', resultSummary: 'Simulated result for "Build API". No AI was run.' })
  })

  it('approval → approve → completed', async () => {
    await begin()
    const id = await startTask()
    await x.until(isType('task.started'))
    expect((await s.api('POST', `/api/demo/tasks/${id}/request-approval`)).status).toBe(202)
    const asked = (await x.next(isType('task.waiting_for_approval'))) as ChangeEvent
    const pending = asked.patch.tasks[0].pendingApproval!
    expect((await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: pending.id, decision: 'approve' })).status).toBe(200)
    await x.until(isType('task.completed'))
    expect(typesFor(id)).toContain('task.completed')
  })

  it('approval → deny → failed', async () => {
    await begin()
    const id = await startTask()
    await x.until(isType('task.started'))
    await s.api('POST', `/api/demo/tasks/${id}/request-approval`)
    const asked = (await x.next(isType('task.waiting_for_approval'))) as ChangeEvent
    await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: asked.patch.tasks[0].pendingApproval!.id, decision: 'deny' })
    const failed = (await x.next(isType('task.failed'))) as ChangeEvent
    expect(failed.patch.tasks[0].errorMessage).toBe('Approval denied (simulated)')
  })

  it('cancel → cancelling → cancelled', async () => {
    await begin()
    const id = await startTask()
    await x.until(isType('task.started'))
    expect((await s.api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202)
    const cancelling = (await x.next((e) => e.type === 'state.changed' && (e as ChangeEvent).patch.tasks[0]?.status === 'cancelling')) as ChangeEvent
    expect(cancelling.patch.tasks[0].id).toBe(id)
    const cancelled = (await x.next(isType('task.cancelled'))) as ChangeEvent
    expect(cancelled.patch.tasks[0].endedReason).toBe('cancelled')
    const idle = (await x.next((e) => e.type === 'agent.status_changed')) as ChangeEvent
    expect(idle.to).toBe('idle')
  })

  it('timeout → failed with timeout', async () => {
    await begin({ TASK_TIMEOUT_MS: '600' }, { thinkingMs: 5000, workingMs: 5000 })
    await startTask()
    const failed = (await x.next(isType('task.failed'), 3000)) as ChangeEvent
    expect(failed.patch.tasks[0]).toMatchObject({ endedReason: 'timeout', errorMessage: 'Timed out after 1 s' })
  })

  it('duplicate start is rejected', async () => {
    await begin()
    await startTask()
    const second = await s.api('POST', `/api/agents/${FORGE}/tasks`, { title: 'Again' })
    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: 'Forge already has an active task.' })
    await x.until(isType('task.started'))
    await new Promise((r) => setTimeout(r, 120))
    expect(x.events.filter(isType('task.started'))).toHaveLength(1)
  })

  it('snapshot plus events stays consistent', async () => {
    const s0 = await begin()
    await s.api('POST', '/api/agents', { name: 'Nova', role: 'Researcher', department: 'design' })
    await s.api('PUT', '/api/agents/agent-demo-qa/desk', { deskId: 'desk-14' })
    const id = await startTask()
    await x.until(isType('task.started'))
    await s.api('POST', `/api/demo/tasks/${id}/request-approval`)
    const asked = (await x.next(isType('task.waiting_for_approval'))) as ChangeEvent
    await s.api('POST', `/api/tasks/${id}/approval`, { approvalId: asked.patch.tasks[0].pendingApproval!.id, decision: 'approve' })
    await x.until(isType('task.completed'))
    await s.api('DELETE', '/api/agents/agent-demo-pm')

    let latest = await state()
    const end = Date.now() + 1000
    while (x.events.at(-1)?.id !== latest.lastEventId) {
      if (Date.now() > end) throw new Error('stream did not catch up')
      await new Promise((r) => setTimeout(r, 10))
      latest = await state()
    }
    expect(x.events.reduce(applyWorkforceEvent, s0.state)).toEqual(latest.state)
  })

  it('the saved file matches the served state', async () => {
    await begin()
    await startTask()
    await x.until(isType('task.completed'))
    const served = (await state()).state
    expect(parseWorkforce(JSON.parse(readFileSync(join(s.dataDir, WORKFORCE_FILE), 'utf8')))).toEqual(served)
  })
})
