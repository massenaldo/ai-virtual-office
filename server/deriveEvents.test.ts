import { describe, expect, it } from 'vitest'
import { applyWorkforceEvent, type ChangeEvent } from '../src/workforce/api'
import { createDemoWorkforce, restoreDemoAgents } from '../src/workforce/demo'
import { applyRuntimeEvent, assignDesk, assignTask, createAgent, decideApproval, markStarting, removeAgent, requestCancel, timeOutTask, updateAgent, cancelTask } from '../src/workforce/operations'
import type { WorkforceState } from '../src/workforce/types'
import { deriveEvents } from './deriveEvents'

const NOW = '2026-10-31T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const stamp = (d: ReturnType<typeof deriveEvents>[number], i = 1): ChangeEvent => ({ ...d, id: `test:${i}`, at: NOW })
const types = (b: WorkforceState, a: WorkforceState) => deriveEvents(b, a).map((e) => e.type)

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(String((r as { error?: string }).error))
  return r as Extract<T, { ok: true }>
}

/** A started task for Forge, ready for the next step. */
function startedFor(agentId = 'agent-demo-backend', timeoutMs: number | null = null) {
  const queued = ok(assignTask(demo, agentId, { title: 'Build API', description: '' }, NOW, { timeoutMs }))
  const starting = markStarting(queued.state, queued.taskId, NOW)
  const running = applyRuntimeEvent(starting, { type: 'started', taskId: queued.taskId, executionId: 'exec-1' }, NOW, 'mock')
  return { queued, starting, running, taskId: queued.taskId }
}

describe('deriveEvents', () => {
  it('same reference yields no events', () => {
    expect(deriveEvents(demo, demo)).toEqual([])
  })

  it('createAgent yields one state.changed carrying the agent and its activity', () => {
    const r = ok(createAgent(demo, { name: 'Nova', role: 'Planner', department: 'design' }, NOW))
    const events = deriveEvents(demo, r.state)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'state.changed' })
    expect(events[0].patch.agents.map((a) => a.id)).toEqual([r.id])
    expect(events[0].patch.activities[0]).toMatchObject({ type: 'agent-created', agentId: r.id })
  })

  it('assignTask then markStarting', () => {
    const { queued, starting, taskId } = startedFor()
    const assigned = deriveEvents(demo, queued.state)
    expect(assigned).toHaveLength(1)
    expect(assigned[0]).toMatchObject({ type: 'task.queued', taskId, agentId: 'agent-demo-backend' })
    expect(assigned[0].patch.tasks[0]).toMatchObject({ id: taskId, status: 'queued' })

    const started = deriveEvents(queued.state, starting)
    expect(started.map((e) => e.type)).toEqual(['agent.status_changed', 'state.changed'])
    expect(started[0]).toMatchObject({ from: 'idle', to: 'thinking', agentId: 'agent-demo-backend' })
    expect(started[1].patch.tasks[0].status).toBe('starting')
  })

  it('started and progress', () => {
    const { starting, running, taskId } = startedFor()
    const started = deriveEvents(starting, running)
    expect(started.map((e) => e.type)).toEqual(['task.started'])
    expect(started[0].patch.tasks[0]).toMatchObject({ status: 'running', executionId: 'exec-1' })
    const progress = applyRuntimeEvent(running, { type: 'progress', taskId, step: 'working', message: 'Working' }, NOW, 'mock')
    expect(types(running, progress)).toEqual(['task.progress', 'agent.status_changed'])
    expect(deriveEvents(running, progress)[1]).toMatchObject({ from: 'thinking', to: 'working' })
  })

  it('message events become agent.message', () => {
    const { running, taskId } = startedFor()
    const next = applyRuntimeEvent(running, { type: 'message', taskId, text: 'Reading the spec' }, NOW, 'mock')
    expect(types(running, next)).toEqual(['agent.message'])
  })

  it('approval requested and decided', () => {
    const { running, taskId } = startedFor()
    const waiting = applyRuntimeEvent(running, { type: 'approval_requested', taskId, approvalId: 'a1', tool: 'Write', summary: 'Write a file' }, NOW, 'mock')
    const asked = deriveEvents(running, waiting)
    expect(asked.map((e) => e.type)).toEqual(['task.waiting_for_approval', 'agent.status_changed'])
    expect(asked[0].patch.tasks[0].pendingApproval?.tool).toBe('Write')
    expect(asked[1]).toMatchObject({ from: 'thinking', to: 'waiting' })
    const decided = decideApproval(waiting, taskId, 'a1', 'approve', NOW, 'mock')
    expect(types(waiting, decided)).toEqual(['state.changed', 'agent.status_changed'])
  })

  it('completed, failed and cancelled map to their events', () => {
    const { running, taskId } = startedFor()
    expect(types(running, applyRuntimeEvent(running, { type: 'completed', taskId, summary: 'Done' }, NOW, 'mock'))).toEqual(['task.completed', 'agent.status_changed'])
    expect(types(running, applyRuntimeEvent(running, { type: 'failed', taskId, error: 'Boom' }, NOW, 'mock'))).toEqual(['task.failed', 'agent.status_changed'])
    expect(types(running, applyRuntimeEvent(running, { type: 'cancelled', taskId }, NOW, 'mock'))).toEqual(['task.cancelled', 'agent.status_changed'])
  })

  it('timeOutTask yields task.failed with endedReason timeout', () => {
    const { running, taskId } = startedFor('agent-demo-backend', 600000)
    const next = timeOutTask(running, taskId, NOW, 'mock')
    const events = deriveEvents(running, next)
    expect(events.map((e) => e.type)).toEqual(['task.failed', 'agent.status_changed'])
    expect(events[0].patch.tasks[0]).toMatchObject({ status: 'failed', endedReason: 'timeout' })
  })

  it('removeAgent yields one state.changed with removedAgentIds', () => {
    const { running } = startedFor()
    const next = removeAgent(running, 'agent-demo-backend').state
    const events = deriveEvents(running, next)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'state.changed', agentId: 'agent-demo-backend' })
    expect(events[0].patch.removedAgentIds).toEqual(['agent-demo-backend'])
  })
})

describe('invariant: folding derived events onto before gives after', () => {
  it('holds across every operation, including activity trimming', () => {
    const pairs: Array<[WorkforceState, WorkforceState]> = []
    let s = demo
    const step = (next: WorkforceState) => { pairs.push([s, next]); s = next }
    const run = (event: Parameters<typeof applyRuntimeEvent>[1]) => step(applyRuntimeEvent(s, event, NOW, 'mock'))

    const nova = ok(createAgent(s, { name: 'Nova', role: 'Planner', department: 'design' }, NOW)); step(nova.state)
    step(ok(updateAgent(s, nova.id, { role: 'Lead' }, NOW)).state)
    step(ok(assignDesk(s, nova.id, 'desk-04', NOW)).state)
    step(ok(assignDesk(s, nova.id, null, NOW)).state)

    // A full task: queued → starting → started → progress → message → approval → approve → completed.
    const a = ok(assignTask(s, 'agent-demo-backend', { title: 'Build API', description: '' }, NOW)); step(a.state)
    step(markStarting(s, a.taskId, NOW))
    run({ type: 'started', taskId: a.taskId, executionId: 'exec-a' })
    run({ type: 'progress', taskId: a.taskId, step: 'working', message: 'Working' })
    run({ type: 'message', taskId: a.taskId, text: 'Reading' })
    run({ type: 'approval_requested', taskId: a.taskId, approvalId: 'ap1', tool: 'Write', summary: 'Write a file' })
    step(decideApproval(s, a.taskId, 'ap1', 'approve', NOW, 'mock'))
    run({ type: 'completed', taskId: a.taskId, summary: 'Done' })

    // Cancel path, timeout path and a queued cancel.
    const b = ok(assignTask(s, 'agent-demo-qa', { title: 'Run tests', description: '' }, NOW)); step(b.state)
    step(markStarting(s, b.taskId, NOW))
    run({ type: 'started', taskId: b.taskId, executionId: 'exec-b' })
    step(requestCancel(s, b.taskId, NOW, 'mock'))
    run({ type: 'cancelled', taskId: b.taskId })
    const c = ok(assignTask(s, 'agent-demo-backend', { title: 'Slow', description: '' }, NOW, { timeoutMs: 1000 })); step(c.state)
    step(markStarting(s, c.taskId, NOW))
    run({ type: 'started', taskId: c.taskId, executionId: 'exec-c' })
    step(timeOutTask(s, c.taskId, NOW, 'mock'))
    const d = ok(assignTask(s, 'agent-demo-backend', { title: 'Never started', description: '' }, NOW)); step(d.state)
    step(requestCancel(s, d.taskId, NOW, 'mock'))
    const e = ok(assignTask(s, 'agent-demo-frontend', { title: 'Lost runtime', description: '' }, NOW)); step(e.state)
    step(markStarting(s, e.taskId, NOW))
    step(cancelTask(s, e.taskId, NOW))

    // Removal and restore.
    step(removeAgent(s, 'agent-demo-qa').state)
    step(restoreDemoAgents(s, NOW))

    // 305 messages push the activity log past its limit.
    const m = ok(assignTask(s, 'agent-demo-pm', { title: 'Chatty', description: '' }, NOW)); step(m.state)
    step(markStarting(s, m.taskId, NOW))
    run({ type: 'started', taskId: m.taskId, executionId: 'exec-m' })
    for (let i = 0; i < 305; i++) run({ type: 'message', taskId: m.taskId, text: `m${i}` })

    expect(pairs.length).toBeGreaterThan(330)
    for (const [before, after] of pairs) {
      const folded = deriveEvents(before, after).map((d, i) => stamp(d, i + 1)).reduce(applyWorkforceEvent, before)
      expect(folded).toEqual(after)
    }
    expect(s.activities).toHaveLength(300)
  })
})
