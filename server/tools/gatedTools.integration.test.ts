import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../../src/workforce/types'
import { createApp, type App } from '../app'
import { AUDIT_FILE, type AuditRecord } from '../audit'
import { parseConfig, type ServerConfig } from '../config'
import { silentLogger } from '../log'
import { toolPolicyFrom } from '../toolPolicy'
import { FakeProvider } from '../test/fakeProvider'
import { makeWorkspaceRoot } from '../test/workspaces'
import { createGatedTools, RESULT_TEXT } from './gatedTools'

// Scenario 3 needs to act between the gate's permit and the final rename. fileOps is synchronous, so the only
// deterministic seam is the write hook: the mock below forwards a test-supplied beforeRename to the real writeTextFile.
const seam = vi.hoisted(() => ({ beforeRename: null as null | (() => void) }))
vi.mock('../fileOps', async (importActual) => {
  const actual = await importActual<typeof import('../fileOps')>()
  return {
    ...actual,
    writeTextFile: (ws: string, rel: string, content: string, signal: AbortSignal, hooks?: import('../fileOps').WriteHooks) =>
      actual.writeTextFile(ws, rel, content, signal, { ...hooks, beforeRename: () => { seam.beforeRename?.(); hooks?.beforeRename?.() } }),
  }
})

const FORGE = 'agent-demo-backend'
const CONTENT = 'CANARY-CONTENT-7f3a9c line one\nline two\n'

let base: string
let dataDir: string
let ws: ReturnType<typeof makeWorkspaceRoot>
let outside: string
let app: App
let fake: FakeProvider
let config: ServerConfig

function build(opts: { allowedTools?: string; dataInsideWorkspace?: boolean } = {}): void {
  const dir = opts.dataInsideWorkspace ? join(ws.path('sandbox'), 'vo-data') : dataDir
  const parsed = parseConfig({ PORT: '0', DATA_DIR: dataDir, API_TOKEN: 'test-token-0123456789-abcdefghijklmnopqrstuvwxyz', ...ws.env, ...(opts.allowedTools ? { ALLOWED_TOOLS: opts.allowedTools } : {}) })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  // The config parser refuses a data dir inside a workspace, so that variant swaps it in afterwards.
  config = { ...parsed.config, dataDir: dir }
  fake = new FakeProvider()
  app = createApp(config, { provider: fake, log: silentLogger })
}

beforeEach(() => {
  vi.useFakeTimers()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'vo-gated-')))
  dataDir = join(base, 'data')
  outside = join(base, 'outside')
  mkdirSync(dataDir)
  mkdirSync(outside)
  ws = makeWorkspaceRoot(['sandbox'])
  mkdirSync(join(ws.path('sandbox'), 'dir'))
  writeFileSync(join(ws.path('sandbox'), 'dir', 'notes.md'), 'hello notes')
  build()
})
afterEach(async () => {
  seam.beforeRename = null
  await app.manager.dispose()
  app.audit.close()
  app.releaseLock()
  vi.useRealTimers()
  rmSync(base, { recursive: true, force: true })
  ws.cleanup()
})

const tick = () => vi.advanceTimersByTimeAsync(0)
const wsPath = () => ws.path('sandbox')
const task = (id: string): AgentTask => app.store.state.tasks.find((t) => t.id === id)!
const auditRecords = (): AuditRecord[] => readFileSync(join(config.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord)
const protectedRoots = () => toolPolicyFrom(config).protectedRoots

async function start(index = 0) {
  const r = app.manager.startTask(FORGE, { title: 'T', description: '' }, { workspaceId: 'sandbox' })
  if (!r.ok) throw new Error(r.error)
  await tick()
  fake.emit({ type: 'started', taskId: r.task.id, executionId: `e${index}` })
  const ctx = fake.starts[index].ctx
  return { id: r.task.id, tools: createGatedTools(ctx, { protectedRoots: protectedRoots() }) }
}
const decide = (id: string, choice: Parameters<App['manager']['decideApproval']>[2]) => {
  const p = task(id).pendingApproval!
  return app.manager.decideApproval(id, p.id, choice, {}, p.digest ?? undefined)
}
const strayTemps = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('write through the approval flow', () => {
  it('waits for approval, writes the exact content on approve, and audits the decision', async () => {
    const { id, tools } = await start()
    const pending = tools.vo_write({ file_path: 'dir/out.txt', content: CONTENT })
    await tick()
    expect(task(id).status).toBe('waiting_for_approval')
    expect(existsSync(join(wsPath(), 'dir', 'out.txt'))).toBe(false)
    expect(decide(id, 'allow_once').ok).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(readFileSync(join(wsPath(), 'dir', 'out.txt'), 'utf8')).toBe(CONTENT)
    expect(task(id).status).toBe('running')
  })

  it('writes nothing when the approval is rejected, and audits the reject', async () => {
    const { id, tools } = await start()
    const pending = tools.vo_write({ file_path: 'dir/out.txt', content: CONTENT })
    await tick()
    expect(decide(id, 'reject').ok).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, error: 'denied', text: RESULT_TEXT.denied })
    expect(existsSync(join(wsPath(), 'dir', 'out.txt'))).toBe(false)
    expect(strayTemps(join(wsPath(), 'dir'))).toEqual([])
    expect(auditRecords().find((r) => r.action === 'approval.decided')).toMatchObject({ decision: 'reject', taskId: id })
  })
})

describe('allow for this task', () => {
  it('lets a second write run with no prompt, ends with the task, and the next task prompts again', async () => {
    fake.confirmCancel = true
    const { id, tools } = await start()
    const first = tools.vo_write({ file_path: 'dir/a.txt', content: 'a' })
    await tick()
    expect(decide(id, 'allow_task').ok).toBe(true)
    await first
    const second = await tools.vo_write({ file_path: 'dir/b.txt', content: 'b' })
    expect(second.ok).toBe(true)
    expect(task(id).status).toBe('running')
    expect(readFileSync(join(wsPath(), 'dir', 'b.txt'), 'utf8')).toBe('b')
    const rule = app.permissions.rules.find((r) => r.scope === 'task')!
    expect(rule.endedAt).toBeNull()
    app.manager.cancelTask(id)
    expect(app.permissions.rules.find((r) => r.id === rule.id)!.endedAt).not.toBeNull()
    const next = await start(1)
    void next.tools.vo_write({ file_path: 'dir/c.txt', content: 'c' })
    await tick()
    expect(task(next.id).status).toBe('waiting_for_approval')
    expect(existsSync(join(wsPath(), 'dir', 'c.txt'))).toBe(false)
  })
})

describe('revoking the task rule during a write', () => {
  it('aborts the write just before the rename: target unchanged, no temp file', async () => {
    const { id, tools } = await start()
    const rule = app.permissions.grant({ scope: 'task', effect: 'allow', tool: 'Write', agentId: FORGE, taskId: id })
    if (!rule.ok) throw new Error(rule.error)
    writeFileSync(join(wsPath(), 'dir', 'target.txt'), 'ORIGINAL')
    let revoked = false
    let tempsInHook = -1
    seam.beforeRename = () => {
      // The temp file exists and holds the new content at this point; the real revoke path aborts the call's signal.
      tempsInHook = strayTemps(join(wsPath(), 'dir')).length
      revoked = app.manager.revokePermission(rule.rule.id).ok
    }
    const result = await tools.vo_write({ file_path: 'dir/target.txt', content: CONTENT })
    expect(tempsInHook).toBe(1)
    expect(revoked).toBe(true)
    expect(result).toEqual({ ok: false, error: 'aborted', text: RESULT_TEXT.aborted })
    expect(readFileSync(join(wsPath(), 'dir', 'target.txt'), 'utf8')).toBe('ORIGINAL')
    expect(strayTemps(join(wsPath(), 'dir'))).toEqual([])
  })
})

describe('policy refuses before any prompt', () => {
  const started = new WeakMap<App, Awaited<ReturnType<typeof start>>>()
  const ask = async (call: (t: Awaited<ReturnType<typeof start>>['tools']) => Promise<{ ok: boolean; text: string; error?: string }>) => {
    const { id, tools } = started.get(app) ?? (await start())
    started.set(app, { id, tools })
    const seen: string[] = []
    const unsub = fake.subscribe((e) => seen.push(e.type))
    const result = await call(tools)
    await tick()
    unsub()
    expect(task(id).status).toBe('running')
    expect(seen).not.toContain('approval_requested')
    return result
  }
  const denied = { ok: false, error: 'denied_by_policy', text: RESULT_TEXT.denied_by_policy }

  it('denies Write, Edit and Read of .env', async () => {
    writeFileSync(join(wsPath(), '.env'), 'TOKEN=abc')
    expect(await ask((t) => t.vo_write({ file_path: '.env', content: 'x' }))).toEqual(denied)
    expect(await ask((t) => t.vo_edit({ file_path: '.env', old_string: 'abc', new_string: 'z' }))).toEqual(denied)
    expect(await ask((t) => t.vo_read({ file_path: '.env' }))).toEqual(denied)
    expect(readFileSync(join(wsPath(), '.env'), 'utf8')).toBe('TOKEN=abc')
    expect(auditRecords().map((r) => r.action)).not.toContain('approval.requested')
  })

  // The separate (outside-workspace) data dir needs no relative-path case: no workspace-relative path can reach it.
  it('denies a path inside a data folder that sits inside the workspace', async () => {
    await app.manager.dispose()
    app.audit.close()
    app.releaseLock()
    build({ dataInsideWorkspace: true })
    expect(realpathSync(config.dataDir).startsWith(wsPath())).toBe(true)
    writeFileSync(join(config.dataDir, 'state.json'), '{}')
    expect(protectedRoots()).toEqual([realpathSync(config.dataDir)])
    expect(await ask((t) => t.vo_write({ file_path: 'vo-data/new.txt', content: 'x' }))).toEqual(denied)
    expect(await ask((t) => t.vo_edit({ file_path: 'vo-data/state.json', old_string: '{}', new_string: '{"a":1}' }))).toEqual(denied)
    expect(await ask((t) => t.vo_read({ file_path: 'vo-data/state.json' }))).toEqual(denied)
    expect(existsSync(join(config.dataDir, 'new.txt'))).toBe(false)
    expect(readFileSync(join(config.dataDir, 'state.json'), 'utf8')).toBe('{}')
  })
})

describe('symlinks', () => {
  it('fails a write through ws/link -> outside, creates nothing outside, and leaks no path', async () => {
    symlinkSync(outside, join(wsPath(), 'link'))
    const { id, tools } = await start()
    const result = await tools.vo_write({ file_path: 'link/x', content: CONTENT })
    expect(result).toMatchObject({ ok: false, error: 'denied_by_policy' }) // refused by the policy before any prompt
    expect(task(id).status).toBe('running')
    expect(readdirSync(outside)).toEqual([])
    expect(result.text).not.toContain(base)
    expect(Object.values(RESULT_TEXT)).toContain(result.text)
  })

  it('refuses a stale approval after the directory is swapped for a symlink', async () => {
    const { id, tools } = await start()
    const pending = tools.vo_write({ file_path: 'dir/new.txt', content: CONTENT })
    await tick()
    expect(task(id).status).toBe('waiting_for_approval')
    renameSync(join(wsPath(), 'dir'), join(wsPath(), 'dir-moved'))
    symlinkSync(outside, join(wsPath(), 'dir'))
    expect(decide(id, 'allow_once').ok).toBe(true)
    const result = await pending
    expect(result).toEqual({ ok: false, error: 'stale_approval', text: RESULT_TEXT.stale_approval })
    expect(auditRecords().some((r) => r.action === 'tool.stale' && r.taskId === id)).toBe(true)
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(join(wsPath(), 'dir-moved')).sort()).toEqual(['notes.md'])
    expect(result.text).not.toContain(base)
  })
})

describe('audit', () => {
  it('records the happy path with neither file content nor absolute paths', async () => {
    const { id, tools } = await start()
    const pending = tools.vo_write({ file_path: 'dir/out.txt', content: CONTENT })
    await tick()
    decide(id, 'allow_once')
    await pending
    await tools.vo_read({ file_path: 'dir/out.txt' })
    const records = auditRecords()
    const actions = records.map((r) => r.action)
    for (const a of ['tool.asked', 'approval.requested', 'approval.decided', 'permission.used', 'tool.allowed']) expect(actions).toContain(a)
    const raw = readFileSync(join(config.dataDir, AUDIT_FILE), 'utf8')
    expect(raw).not.toContain('CANARY-CONTENT')
    expect(raw).not.toContain('line two')
    for (const p of [base, wsPath(), ws.root, config.dataDir, outside]) expect(raw).not.toContain(p)
  })

  it('reads an allowed file with no prompt and audits tool.allowed', async () => {
    const { id, tools } = await start()
    const result = await tools.vo_read({ file_path: 'dir/notes.md' })
    expect(result).toEqual({ ok: true, text: 'hello notes' })
    expect(task(id).status).toBe('running')
    expect(auditRecords().find((r) => r.action === 'tool.allowed' && r.tool === 'Read')).toMatchObject({ taskId: id })
  })
})

describe('vo_run runs nothing', () => {
  const snapshot = () => [readdirSync(wsPath()).sort(), readdirSync(join(wsPath(), 'dir')).sort(), readdirSync(outside).sort()]

  it('is denied by the default Bash rule, audited, with nothing run', async () => {
    await app.manager.dispose()
    app.audit.close()
    app.releaseLock()
    build({ allowedTools: 'Read,Glob,Grep,Write,Edit,Bash' })
    const before = snapshot()
    const { id, tools } = await start()
    const result = await tools.vo_run({ command: 'touch pwned' })
    expect(result).toEqual({ ok: false, error: 'denied_by_policy', text: RESULT_TEXT.denied_by_policy })
    expect(task(id).status).toBe('running')
    expect(auditRecords().find((r) => r.action === 'permission.denied')).toMatchObject({ tool: 'Bash', ruleId: 'default-bash' })
    expect(snapshot()).toEqual(before)
  })

  it('with the default deny revoked and a once grant approved, still returns not_supported', async () => {
    await app.manager.dispose()
    app.audit.close()
    app.releaseLock()
    build({ allowedTools: 'Read,Glob,Grep,Write,Edit,Bash' })
    app.permissions.revoke('default-bash')
    app.permissions.grant({ scope: 'global', effect: 'ask', tool: 'Bash' })
    const before = snapshot()
    const { id, tools } = await start()
    const pending = tools.vo_run({ command: 'touch pwned' })
    await tick()
    expect(task(id).status).toBe('waiting_for_approval')
    expect(decide(id, 'allow_once').ok).toBe(true)
    await expect(pending).resolves.toEqual({ ok: false, error: 'not_supported', text: RESULT_TEXT.not_supported })
    expect(snapshot()).toEqual(before)
    expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false)
  })
})
