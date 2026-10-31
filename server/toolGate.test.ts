import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { StartContext, ToolGate, ToolGateResult } from './runtime/types'
import { actionDigest, canonicalJson, createToolGate } from './toolGate'
import { DEFAULT_ALLOWED_TOOLS } from './toolPolicy'
import { makeWorkspaceRoot } from './test/workspaces'
import { resolveWorkspace } from './workspaces'

let ws: ReturnType<typeof makeWorkspaceRoot>
let outside: ReturnType<typeof makeWorkspaceRoot>
beforeEach(() => { ws = makeWorkspaceRoot(['sandbox']); outside = makeWorkspaceRoot(['x']); mkdirSync(join(ws.path('sandbox'), 'sub')); writeFileSync(join(ws.path('sandbox'), 'notes.md'), 'hi') })
afterEach(() => { ws.cleanup(); outside.cleanup() })

const ALLOWED: ToolGateResult = { behavior: 'allow', outcome: 'approved' }
const policy = { allowedTools: new Set(DEFAULT_ALLOWED_TOOLS) }
const workspace = () => {
  const r = resolveWorkspace({ workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }] }, 'sandbox')
  return r.ok ? ({ ok: true, workspace: r.workspace } as const) : ({ ok: false } as const)
}

function gate(approve: (request: { tool: string; input: unknown }, digest: string) => Promise<ToolGateResult>, extra: { isLive?: () => boolean; stale?: (tool: string, detail: string) => void } = {}): ToolGate {
  return createToolGate({ taskId: 'task-1', policy, workspace, isLive: extra.isLive ?? (() => true), approve, stale: extra.stale ?? (() => {}) })
}
const write = { tool: 'Write', input: { file_path: 'sub/out.txt', content: 'x' } }

describe('createToolGate', () => {
  it.each<ToolGateResult>([
    { behavior: 'deny', outcome: 'denied_by_policy', message: 'm' },
    { behavior: 'deny', outcome: 'denied', message: 'm' },
    { behavior: 'deny', outcome: 'expired', message: 'm' },
    { behavior: 'deny', outcome: 'cancelled', message: 'm' },
  ])('never performs when the answer is %j', async (answer) => {
    const perform = vi.fn()
    expect(await gate(() => Promise.resolve(answer)).use(write, perform)).toEqual(answer)
    expect(perform).not.toHaveBeenCalled()
  })

  it('performs once, with a frozen copy of the input and the checked workspace', async () => {
    const input = { file_path: 'sub/out.txt', content: 'x' }
    let release!: (r: ToolGateResult) => void
    const perform = vi.fn((a: { tool: string; input: unknown; workspace: { id: string } | null }) => a)
    const pending = gate(() => new Promise<ToolGateResult>((resolve) => { release = resolve })).use({ tool: 'Write', input }, perform)
    input.file_path = '../../etc/passwd'
    input.content = 'tampered'
    release(ALLOWED)
    const out = await pending
    expect(perform).toHaveBeenCalledTimes(1)
    const action = perform.mock.calls[0][0]
    expect(action.input).toEqual({ file_path: 'sub/out.txt', content: 'x' })
    expect(Object.isFrozen(action.input)).toBe(true)
    expect(action.workspace).toMatchObject({ id: 'sandbox', path: ws.path('sandbox') })
    expect(out).toMatchObject({ behavior: 'allow', outcome: 'approved' })
  })

  it('hands the approver a frozen input and a 64-hex digest', async () => {
    const seen: Array<{ input: unknown; digest: string }> = []
    await gate((request, digest) => { seen.push({ input: request.input, digest }); return Promise.resolve(ALLOWED) }).use(write, () => 'ok')
    expect(Object.isFrozen(seen[0].input)).toBe(true)
    expect(seen[0].digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the value perform produced', async () => {
    const out = await gate(() => Promise.resolve(ALLOWED)).use(write, () => 42)
    expect(out).toEqual({ behavior: 'allow', outcome: 'approved', value: 42 })
  })

  it('refuses a stale approval when a symlink was re-pointed outside after approval', async () => {
    const perform = vi.fn()
    const stale = vi.fn()
    const g = gate(() => {
      rmSync(join(ws.path('sandbox'), 'sub'), { recursive: true })
      symlinkSync(outside.root, join(ws.path('sandbox'), 'sub'))
      return Promise.resolve(ALLOWED)
    }, { stale })
    const out = await g.use(write, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
    expect(stale).toHaveBeenCalledWith('Write', expect.stringContaining('path'))
  })

  it('refuses a stale approval when the workspace moved after approval', async () => {
    const perform = vi.fn()
    const out = await gate(() => { renameSync(ws.path('sandbox'), join(ws.root, 'moved')); return Promise.resolve(ALLOWED) }).use(write, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('does not perform once the task is no longer running', async () => {
    const perform = vi.fn()
    const out = await gate(() => Promise.resolve(ALLOWED), { isLive: () => false }).use(write, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'cancelled' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('re-checks a read at use time too', async () => {
    const perform = vi.fn()
    const read = { tool: 'Read', input: { file_path: 'sub/notes.md' } }
    const out = await gate(() => {
      rmSync(join(ws.path('sandbox'), 'sub'), { recursive: true })
      symlinkSync(outside.root, join(ws.path('sandbox'), 'sub'))
      return Promise.resolve({ behavior: 'allow', outcome: 'allowed' })
    }).use(read, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'stale_approval' })
    expect(perform).not.toHaveBeenCalled()
  })

  it('refuses an input that cannot be copied', async () => {
    const perform = vi.fn()
    const out = await gate(() => Promise.resolve(ALLOWED)).use({ tool: 'Write', input: { file_path: 'a', content: () => 1 } }, perform)
    expect(out).toMatchObject({ behavior: 'deny', outcome: 'denied_by_policy' })
    expect(perform).not.toHaveBeenCalled()
  })
})

describe('actionDigest', () => {
  const base = { taskId: 't', workspaceId: 'sandbox', workspacePath: '/w', tool: 'Write', input: { b: 1, a: { d: 2, c: 3 } } }
  it('ignores key order and changes with every part', () => {
    expect(actionDigest(base)).toBe(actionDigest({ ...base, input: { a: { c: 3, d: 2 }, b: 1 } }))
    for (const change of [{ taskId: 'u' }, { workspaceId: 'other' }, { workspacePath: '/v' }, { tool: 'Edit' }, { input: { b: 2, a: { d: 2, c: 3 } } }]) expect(actionDigest({ ...base, ...change })).not.toBe(actionDigest(base))
  })
  it('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: [{ z: 1, y: 2 }], a: null })).toBe('{"a":null,"b":[{"y":2,"z":1}]}')
  })
})

describe('the start context', () => {
  it('has a gate and no raw approval or policy', () => {
    expectTypeOf<StartContext>().not.toHaveProperty('requestToolApproval')
    expectTypeOf<StartContext['tools']>().toEqualTypeOf<ToolGate>()
  })
})
