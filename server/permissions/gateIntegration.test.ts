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
