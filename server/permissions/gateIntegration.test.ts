import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../../src/workforce/types'
import { silentLogger } from '../log'
import { openWorkforceStore, type WorkforceStore } from '../store'
import { TaskManager, type LifecycleEvent } from '../taskManager'
import { FakeProvider } from '../test/fakeProvider'
import { makeWorkspaceRoot } from '../test/workspaces'
import { DEFAULT_ALLOWED_TOOLS } from '../toolPolicy'
import { openPermissionStore, type PermissionStore } from './store'

// The permission rules through the real TaskManager, tool gate, stores and workspace on disk. Every case ends with the same
// question: did `perform` run? For anything revoked, expired, denied or not covered it must not.

const NOW = '2026-11-01T09:00:00.000Z'
const FORGE = 'agent-demo-backend'
const CONFIG = { taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144 }

let dir: string
let clock: number
let store: WorkforceStore
let permissions: PermissionStore
let ws: ReturnType<typeof makeWorkspaceRoot>
let fake: FakeProvider
let manager: TaskManager
let events: LifecycleEvent[]
const now = () => new Date(clock).toISOString()

function build(allowed: readonly string[] = DEFAULT_ALLOWED_TOOLS, limits?: { maxActive: number; maxHistory: number }): void {
  fake = new FakeProvider()
  permissions = openPermissionStore({ dataDir: dir, now, log: silentLogger, writeFile: () => {}, limits })
  manager = new TaskManager({
    store, provider: fake, permissions, policy: { allowedTools: new Set(allowed) },
    config: { ...CONFIG, workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }] },
    now, log: silentLogger, onLifecycle: (e) => events.push(e),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = Date.parse(NOW)
  dir = mkdtempSync(join(tmpdir(), 'vo-perm-gate-'))
  ws = makeWorkspaceRoot(['sandbox'])
  mkdirSync(join(ws.path('sandbox'), 'sub'))
  mkdirSync(join(ws.path('sandbox'), 'secrets'))
  writeFileSync(join(ws.path('sandbox'), 'sub', 'notes.md'), 'hi')
  store = openWorkforceStore({ dataDir: dir, now, log: silentLogger, writeFile: () => {} })
  events = []
  build()
})
afterEach(async () => {
  await manager.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  ws.cleanup()
})

const tick = () => vi.advanceTimersByTimeAsync(0)
const task = (id: string): AgentTask => store.state.tasks.find((t) => t.id === id)!
const actions = () => events.map((e) => e.action)

async function run(agentId = FORGE, index = 0) {
  const r = manager.startTask(agentId, { title: 'T', description: '' }, { workspaceId: 'sandbox' })
  if (!r.ok) throw new Error(r.error)
  await tick()
  fake.emit({ type: 'started', taskId: r.task.id, executionId: `e${index}` })
  return { id: r.task.id, ctx: fake.starts[index].ctx }
}
const write = (file = 'sub/out.txt') => ({ tool: 'Write', input: { file_path: file, content: 'x' } })
const read = { tool: 'Read', input: { file_path: 'sub/notes.md' } }
const agentAllow = (tool = 'Write') => { const r = permissions.grant({ scope: 'agent', effect: 'allow', tool, agentId: FORGE }); if (!r.ok) throw new Error(r.error); return r.rule }

describe('rules decide the request', () => {
  it('allows a read by the default rules with no prompt', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn(() => 'data')
    await expect(ctx.tools.use(read, perform)).resolves.toMatchObject({ behavior: 'allow', outcome: 'allowed', value: 'data' })
    expect(task(id).status).toBe('running')
    expect(events.find((e) => e.action === 'tool.allowed')).toMatchObject({ tool: 'Read', reason: 'read_only' })
  })

  it('asks for a write by default', async () => {
    const { id, ctx } = await run()
    void ctx.tools.use(write(), vi.fn())
    expect(task(id).status).toBe('waiting_for_approval')
    expect(actions()).toContain('tool.asked')
  })

  it('lets an agent allow rule run a write with no prompt, and audits the use with rule id and action hash', async () => {
    const rule = agentAllow()
    const { id, ctx } = await run()
    const perform = vi.fn(() => 'done')
    await expect(ctx.tools.use(write(), perform)).resolves.toMatchObject({ behavior: 'allow', value: 'done' })
    expect(perform).toHaveBeenCalledTimes(1)
    expect(task(id).status).toBe('running')
    expect(events.find((e) => e.action === 'tool.allowed')).toMatchObject({ tool: 'Write', reason: 'permission:agent', ruleId: rule.id })
    expect(events.find((e) => e.action === 'permission.used')).toMatchObject({ ruleId: rule.id, tool: 'Write', actionHash: expect.stringMatching(/^[0-9a-f]{64}$/), digest: expect.stringMatching(/^[0-9a-f]{12}$/) })
  })

  it('stops a read that a global deny rule covers, before perform', async () => {
    const rule = permissions.grant({ scope: 'global', effect: 'deny', tool: 'Read' })
    const { ctx } = await run()
    const perform = vi.fn()
    const out = await ctx.tools.use(read, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy', message: expect.stringContaining('permission rule') })
    expect(perform).not.toHaveBeenCalled()
    expect(events.find((e) => e.action === 'permission.denied')).toMatchObject({ tool: 'Read', ruleId: rule.ok ? rule.rule.id : '' })
    expect(actions()).toContain('tool.denied')
  })

  it('denies a write to secrets/** but not to sub/', async () => {
    agentAllow()
    permissions.grant({ scope: 'global', effect: 'deny', tool: 'Write', pathPattern: 'secrets/**' })
    const { ctx } = await run()
    const blocked = vi.fn()
    const fine = vi.fn(() => 'ok')
    await expect(ctx.tools.use(write('secrets/k.txt'), blocked)).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    await expect(ctx.tools.use(write('sub/k.txt'), fine)).resolves.toMatchObject({ behavior: 'allow' })
    expect(blocked).not.toHaveBeenCalled()
    expect(fine).toHaveBeenCalledTimes(1)
  })

  it('keeps ALLOWED_TOOLS as a ceiling over any rule', async () => {
    await manager.dispose()
    build(['Read', 'Glob', 'Grep'])
    agentAllow()
    const { ctx } = await run()
    const perform = vi.fn()
    await expect(ctx.tools.use(write(), perform)).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('denies Bash by the default rule even when the ceiling lists it', async () => {
    await manager.dispose()
    build([...DEFAULT_ALLOWED_TOOLS, 'Bash'])
    const { ctx } = await run()
    const perform = vi.fn()
    await expect(ctx.tools.use({ tool: 'Bash', input: { command: 'ls' } }, perform)).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    expect(events.find((e) => e.action === 'permission.denied')).toMatchObject({ ruleId: 'default-bash' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('ignores a once rule bound to another digest', async () => {
    const { id, ctx } = await run()
    permissions.grant({ scope: 'once', effect: 'allow', tool: 'Write', agentId: FORGE, taskId: id, digest: 'b'.repeat(64) })
    void ctx.tools.use(write(), vi.fn())
    expect(task(id).status).toBe('waiting_for_approval')
  })
})

describe('a permission withdrawn before perform stops the action', () => {
  it('revoke between the human approval and perform', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    const p = task(id).pendingApproval!
    expect(manager.decideApproval(id, p.id, 'approve', {}, p.digest ?? undefined).ok).toBe(true)
    const once = permissions.rules.find((r) => r.scope === 'once')!
    expect(permissions.revoke(once.id).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'revoked' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('revoke of an agent grant after the request was allowed but before perform', async () => {
    const rule = agentAllow()
    const { ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    expect(permissions.revoke(rule.id).ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'revoked' })
    expect(perform).not.toHaveBeenCalled()
    expect(events.filter((e) => e.action === 'permission.denied').at(-1)).toMatchObject({ reason: 'revoked_or_changed' })
  })

  it('expiry between the request and perform', async () => {
    permissions.grant({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: FORGE, expiresAt: new Date(clock + 1000).toISOString() })
    const { ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use(write(), perform)
    clock += 2000
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'revoked' })
    expect(perform).not.toHaveBeenCalled()
  })
})

describe('cleanup', () => {
  it('ends task and once rules when the task ends', async () => {
    fake.confirmCancel = true
    const { id } = await run()
    const rule = permissions.grant({ scope: 'task', effect: 'allow', tool: 'Write', agentId: FORGE, taskId: id })
    manager.cancelTask(id)
    expect(permissions.rules.find((r) => r.id === (rule.ok ? rule.rule.id : ''))!.endedAt).not.toBeNull()
  })

  it('revokes the agent rules of a removed agent but not global rules', async () => {
    const mine = agentAllow()
    const global = permissions.grant({ scope: 'global', effect: 'allow', tool: 'Glob' })
    await run()
    manager.removeAgent(FORGE)
    expect(permissions.rules.find((r) => r.id === mine.id)!.revokedAt).not.toBeNull()
    expect(permissions.rules.find((r) => r.id === (global.ok ? global.rule.id : ''))!.revokedAt).toBeNull()
  })
})

describe('scoped approval decisions', () => {
  const decide = (id: string, choice: Parameters<TaskManager['decideApproval']>[2], digest?: string) => {
    const p = task(id).pendingApproval!
    return manager.decideApproval(id, p.id, choice, {}, digest ?? p.digest ?? undefined)
  }
  const userRules = () => permissions.rules.filter((r) => r.createdBy !== 'default')

  it('allow_once runs the action once; an identical request asks again', async () => {
    const { id, ctx } = await run()
    const first = vi.fn(() => 'one')
    const p1 = ctx.tools.use(write(), first)
    expect(decide(id, 'allow_once').ok).toBe(true)
    await expect(p1).resolves.toMatchObject({ behavior: 'allow', outcome: 'approved', value: 'one' })
    expect(userRules().map((r) => [r.scope, r.usedAt !== null])).toEqual([['once', true]])
    const second = vi.fn()
    void ctx.tools.use(write(), second)
    expect(task(id).status).toBe('waiting_for_approval')
    expect(second).not.toHaveBeenCalled()
  })

  it('allow_task lets later writes in the task run with no prompt, and ends with the task', async () => {
    fake.confirmCancel = true
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write(), vi.fn())
    expect(decide(id, 'allow_task').ok).toBe(true)
    await p1
    const again = vi.fn(() => 'two')
    await expect(ctx.tools.use(write('sub/b.txt'), again)).resolves.toMatchObject({ behavior: 'allow', value: 'two' })
    expect(task(id).status).toBe('running')
    manager.cancelTask(id)
    const next = await run(FORGE, 1)
    void next.ctx.tools.use(write(), vi.fn())
    expect(task(next.id).status).toBe('waiting_for_approval')
  })

  it('allow_agent carries into the agent next task', async () => {
    fake.confirmCancel = true
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write(), vi.fn())
    expect(decide(id, 'allow_agent').ok).toBe(true)
    await p1
    manager.cancelTask(id)
    const next = await run(FORGE, 1)
    await expect(next.ctx.tools.use(write(), vi.fn(() => 'ok'))).resolves.toMatchObject({ behavior: 'allow', value: 'ok' })
    expect(task(next.id).status).toBe('running')
  })

  it('reject denies, creates no rule and records a deny', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn()
    const p1 = ctx.tools.use(write(), perform)
    expect(decide(id, 'reject').ok).toBe(true)
    await expect(p1).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied' })
    expect(perform).not.toHaveBeenCalled()
    expect(userRules()).toEqual([])
    expect(events.find((e) => e.action === 'approval.decided')).toMatchObject({ decision: 'reject' })
  })

  it('keeps the legacy approve and deny working as once and reject', async () => {
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write(), vi.fn(() => 'ok'))
    expect(decide(id, 'approve').ok).toBe(true)
    await expect(p1).resolves.toMatchObject({ behavior: 'allow' })
    const p2 = ctx.tools.use(write(), vi.fn())
    expect(decide(id, 'deny').ok).toBe(true)
    await expect(p2).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied' })
  })

  it('audits the decision with rule id, digest and action hash', async () => {
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write(), vi.fn())
    decide(id, 'allow_task')
    await p1
    expect(events.find((e) => e.action === 'approval.decided')).toMatchObject({ decision: 'allow_task', ruleId: userRules()[0].id, digest: expect.stringMatching(/^[0-9a-f]{12}$/), actionHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('refuses allow_task for an execute tool and leaves the approval pending', async () => {
    await manager.dispose()
    build([...DEFAULT_ALLOWED_TOOLS, 'Bash'])
    permissions.revoke('default-bash')
    permissions.grant({ scope: 'global', effect: 'ask', tool: 'Bash' })
    const { id, ctx } = await run()
    const perform = vi.fn()
    const pending = ctx.tools.use({ tool: 'Bash', input: { command: 'ls' } }, perform)
    expect(decide(id, 'allow_task')).toEqual({ ok: false, code: 'invalid', error: 'That tool can only be allowed once.' })
    expect(task(id).status).toBe('waiting_for_approval')
    expect(decide(id, 'reject').ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('leaves the approval pending when the permission cannot be recorded', async () => {
    await manager.dispose()
    build(DEFAULT_ALLOWED_TOOLS, { maxActive: 0, maxHistory: 10 })
    const { id, ctx } = await run()
    const perform = vi.fn()
    void ctx.tools.use(write(), perform)
    expect(decide(id, 'allow_once')).toEqual({ ok: false, code: 'unavailable', error: 'The permission could not be recorded.' })
    expect(task(id).status).toBe('waiting_for_approval')
    expect(perform).not.toHaveBeenCalled()
  })

  it('refuses a wrong digest and a second decision', async () => {
    const { id, ctx } = await run()
    void ctx.tools.use(write(), vi.fn())
    expect(decide(id, 'allow_once', 'f'.repeat(64))).toEqual({ ok: false, code: 'conflict', error: 'That approval is no longer pending.' })
    const pending = task(id).pendingApproval!
    expect(manager.decideApproval(id, pending.id, 'allow_once', {}, pending.digest ?? undefined).ok).toBe(true)
    expect(manager.decideApproval(id, pending.id, 'allow_once', {}, pending.digest ?? undefined)).toEqual({ ok: false, code: 'conflict', error: 'Task is not waiting for approval.' })
  })

  it('refuses a scoped grant on an approval the provider raised itself', async () => {
    const { id } = await run()
    fake.emit({ type: 'approval_requested', taskId: id, approvalId: 'inner-1', tool: 'Write', summary: 'Simulated' })
    expect(manager.decideApproval(id, 'inner-1', 'allow_agent')).toEqual({ ok: false, code: 'invalid', error: 'That approval can only be allowed once.' })
    expect(task(id).status).toBe('waiting_for_approval')
    expect(manager.decideApproval(id, 'inner-1', 'allow_once').ok).toBe(true)
  })
})

describe('concurrent requests in one task', () => {
  const pendingSummary = (id: string) => task(id).pendingApproval?.summary ?? ''
  const decide = (id: string, choice: Parameters<TaskManager['decideApproval']>[2]) => {
    const p = task(id).pendingApproval!
    return manager.decideApproval(id, p.id, choice, {}, p.digest ?? undefined)
  }
  const watch = <T,>(p: Promise<T>) => { const box = { settled: false }; void p.then(() => { box.settled = true }); return box }

  it('a second write while one is pending waits and is not denied', async () => {
    const { id, ctx } = await run()
    void ctx.tools.use(write('sub/a.txt'), vi.fn())
    const second = watch(ctx.tools.use(write('sub/b.txt'), vi.fn()))
    await tick()
    expect(second.settled).toBe(false)
    expect(pendingSummary(id)).toContain('sub/a.txt')
  })

  it('a rejected first request does not deny the second, which then asks', async () => {
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write('sub/a.txt'), vi.fn())
    const perform2 = vi.fn(() => 'b')
    const p2 = ctx.tools.use(write('sub/b.txt'), perform2)
    decide(id, 'reject')
    await expect(p1).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied' })
    expect(task(id).status).toBe('waiting_for_approval')
    expect(pendingSummary(id)).toContain('sub/b.txt')
    decide(id, 'allow_once')
    await expect(p2).resolves.toMatchObject({ behavior: 'allow', value: 'b' })
  })

  it('allow for this task also answers a queued write to another file, with no second prompt', async () => {
    const { id, ctx } = await run()
    const perform1 = vi.fn(() => 'a')
    const perform2 = vi.fn(() => 'b')
    const p1 = ctx.tools.use(write('sub/a.txt'), perform1)
    const p2 = ctx.tools.use(write('sub/b.txt'), perform2)
    decide(id, 'allow_task')
    await expect(Promise.all([p1, p2])).resolves.toMatchObject([{ behavior: 'allow', value: 'a' }, { behavior: 'allow', value: 'b' }])
    expect(task(id).status).toBe('running')
  })

  it('a queued identical request cannot reuse a one-time permission, and perform runs once for the pair', async () => {
    const { id, ctx } = await run()
    const perform = vi.fn(() => 'x')
    const p1 = ctx.tools.use(write(), perform)
    const p2 = ctx.tools.use(write(), perform)
    decide(id, 'allow_once')
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toMatchObject({ behavior: 'allow' })
    expect(b).toMatchObject({ behavior: 'deny', outcome: 'revoked' })
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('a queued request for another tool still gets its own prompt', async () => {
    const { id, ctx } = await run()
    const p1 = ctx.tools.use(write('sub/a.txt'), vi.fn())
    const edit = watch(ctx.tools.use({ tool: 'Edit', input: { file_path: 'sub/notes.md', old_string: 'hi', new_string: 'yo' } }, vi.fn()))
    decide(id, 'allow_task')
    await p1
    expect(edit.settled).toBe(false)
    expect(task(id).status).toBe('waiting_for_approval')
    expect(task(id).pendingApproval?.tool).toBe('Edit')
  })

  it('re-evaluates a queued request: a deny rule added while it waited stops it, and a new allow rule lets it run', async () => {
    const { id, ctx } = await run()
    const p1 = ctx.tools.use({ tool: 'Edit', input: { file_path: 'sub/notes.md', old_string: 'hi', new_string: 'yo' } }, vi.fn())
    const denied = vi.fn()
    const allowed = vi.fn(() => 'ok')
    const p2 = ctx.tools.use(write('sub/a.txt'), denied)
    const p3 = ctx.tools.use(write('sub/b.txt'), allowed)
    permissions.grant({ scope: 'global', effect: 'deny', tool: 'Write', pathPattern: 'sub/a.txt' })
    agentAllow()
    decide(id, 'reject')
    await expect(p1).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied' })
    await expect(p2).resolves.toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    await expect(p3).resolves.toMatchObject({ behavior: 'allow', value: 'ok' })
    expect(denied).not.toHaveBeenCalled()
    expect(task(id).status).toBe('running')
  })

  it('refuses the ninth waiting request', async () => {
    const { id, ctx } = await run()
    const pending = Array.from({ length: 9 }, (_, i) => watch(ctx.tools.use(write(`sub/f${i}.txt`), vi.fn())))
    const tenth = await ctx.tools.use(write('sub/f9.txt'), vi.fn())
    expect(tenth).toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy', message: expect.stringContaining('already pending') })
    await tick()
    expect(pending.every((p) => !p.settled)).toBe(true)
    expect(task(id).status).toBe('waiting_for_approval')
  })

  describe.each([
    ['cancel', (id: string) => { fake.confirmCancel = true; manager.cancelTask(id) }],
    ['approval timeout', (_id: string) => { void vi.advanceTimersByTimeAsync(CONFIG.approvalTimeoutMs) }],
    ['agent removal', (_id: string) => { manager.removeAgent(FORGE) }],
    ['dispose', (_id: string) => { void manager.dispose() }],
  ] as const)('on %s', (_name, end) => {
    it('settles the pending request and every queued one without performing', async () => {
      const { id, ctx } = await run()
      const perform = vi.fn()
      const all = [ctx.tools.use(write('sub/a.txt'), perform), ctx.tools.use(write('sub/b.txt'), perform), ctx.tools.use(write('sub/c.txt'), perform)]
      end(id)
      const results = await Promise.all(all)
      expect(results.every((r) => r.behavior === 'deny')).toBe(true)
      expect(perform).not.toHaveBeenCalled()
    })
  })
})

describe('revoking while a call is running', () => {
  /** A perform that stays open until released, and reports the signal it was given. */
  function slow() {
    let release!: () => void
    const done = new Promise<void>((resolve) => { release = resolve })
    const seen: { signal: AbortSignal | null } = { signal: null }
    return { seen, release, perform: async (a: { signal: AbortSignal }) => { seen.signal = a.signal; await done; return 'finished' } }
  }
  const taskRule = (id: string) => { const r = permissions.grant({ scope: 'task', effect: 'allow', tool: 'Write', agentId: FORGE, taskId: id }); if (!r.ok) throw new Error(r.error); return r.rule }

  it('aborts the call of a revoked task rule', async () => {
    const { id, ctx } = await run()
    const rule = taskRule(id)
    const s = slow()
    const pending = ctx.tools.use(write(), s.perform)
    await tick()
    expect(s.seen.signal!.aborted).toBe(false)
    expect(manager.revokePermission(rule.id)).toMatchObject({ ok: true, rule: { id: rule.id } })
    expect(s.seen.signal!.aborted).toBe(true)
    s.release()
    await pending
  })

  it('does not abort a call allowed by an agent rule, but the next request asks', async () => {
    const rule = agentAllow()
    const { id, ctx } = await run()
    const s = slow()
    const pending = ctx.tools.use(write(), s.perform)
    await tick()
    expect(manager.revokePermission(rule.id).ok).toBe(true)
    expect(s.seen.signal!.aborted).toBe(false)
    s.release()
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', value: 'finished' })
    void ctx.tools.use(write('sub/next.txt'), vi.fn())
    expect(task(id).status).toBe('waiting_for_approval')
  })

  it('stops tracking once the call has finished', async () => {
    const { id, ctx } = await run()
    const rule = taskRule(id)
    const s = slow()
    const pending = ctx.tools.use(write(), s.perform)
    await tick()
    s.release()
    await pending
    manager.revokePermission(rule.id)
    expect(s.seen.signal!.aborted).toBe(false)
  })

  it('revokeAgentPermissions aborts task and once calls of that agent only and revokes the rules', async () => {
    const { id, ctx } = await run()
    const rule = taskRule(id)
    const s = slow()
    const pending = ctx.tools.use(write(), s.perform)
    await tick()
    const out = manager.revokeAgentPermissions(FORGE)
    expect(out.ok && out.revoked.map((r) => r.id)).toEqual([rule.id])
    expect(s.seen.signal!.aborted).toBe(true)
    expect(manager.revokeAgentPermissions('agent-missing')).toMatchObject({ ok: false, code: 'not_found' })
    s.release()
    await pending
  })

  it('answers conflict for a rule that is already inactive and not_found for an unknown id', async () => {
    const rule = agentAllow()
    expect(manager.revokePermission(rule.id).ok).toBe(true)
    expect(manager.revokePermission(rule.id)).toMatchObject({ ok: false, code: 'conflict', error: 'That permission is no longer active.' })
    expect(manager.revokePermission('perm-nope')).toMatchObject({ ok: false, code: 'not_found', error: 'Permission not found.' })
  })
})
