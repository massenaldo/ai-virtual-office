import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileOpFailure } from '../fileOps'
import type { GatedAction, GatedOutcome, ToolGate, ToolRequest } from '../runtime/types'
import { createGatedTools, RESULT_TEXT, type ToolErrorCode, type ToolResult } from './gatedTools'

const MARKER = 'MARKER_xq9z_content'
let dir: string
let calls: ToolRequest[]

function approvingGate(paths: (req: ToolRequest) => GatedAction['paths'], ws = () => ({ id: 'w', path: dir }) as GatedAction['workspace']): ToolGate {
  return {
    async use<T>(request: ToolRequest, perform: (a: GatedAction) => Promise<T> | T): Promise<GatedOutcome<T>> {
      calls.push(request)
      const value = await perform({ tool: request.tool, input: freeze(structuredClone(request.input)), workspace: ws(), signal: new AbortController().signal, paths: paths(request) })
      return { behavior: 'allow', outcome: 'approved', value }
    },
  }
}
const pathOf = (req: ToolRequest) => {
  const i = req.input as Record<string, unknown>
  const p = (i.file_path ?? i.path) as string | undefined
  return p === undefined ? [] : [{ arg: 'p', relative: p }]
}
const denyGate = (outcome: Extract<GatedOutcome<never>, { behavior: 'deny' }>['outcome']): ToolGate => ({
  async use() { return { behavior: 'deny', outcome, message: `denied at ${dir} ${MARKER}` } },
})
const errorOf = (r: ToolResult) => (r.ok ? null : r.error)
const make = (gate: ToolGate) => createGatedTools({ tools: gate }, { protectedRoots: [] })

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gt-')))
  calls = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x) }
  return v
}

describe('gated tools', () => {
  it('uses policy tool names', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    const t = make(approvingGate(pathOf))
    await t.vo_read({ file_path: 'a.txt' })
    await t.vo_glob({ pattern: '*.txt' })
    await t.vo_grep({ pattern: 'hello' })
    await t.vo_write({ file_path: 'b.txt', content: 'x' })
    await t.vo_edit({ file_path: 'b.txt', old_string: 'x', new_string: 'y' })
    await t.vo_run({ command: 'ls' })
    expect(calls.map((c) => c.tool)).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'])
  })

  it('reads with offset/limit, redacts and caps', async () => {
    writeFileSync(join(dir, 'a.txt'), 'l1\nl2 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nl3\nl4')
    const t = make(approvingGate(pathOf))
    const r = await t.vo_read({ file_path: 'a.txt', offset: 2, limit: 2 })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('[REDACTED]')
    expect(r.text).not.toContain('sk-ant')
    expect(r.text).toContain('l3')
    expect(r.text).not.toContain('l1')
    expect(r.text).not.toContain('l4')
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(70000))
    const big = await t.vo_read({ file_path: 'big.txt' })
    expect(big.ok).toBe(true)
    expect(Buffer.byteLength(big.text)).toBeLessThan(65536 + 200)
    expect(big.text).toContain('[truncated]')
  })

  it('write and edit texts use the relative path', async () => {
    const t = make(approvingGate(pathOf))
    expect(await t.vo_write({ file_path: 'n.txt', content: 'abc' })).toEqual({ ok: true, text: 'Wrote 3 bytes to n.txt.' })
    expect(await t.vo_edit({ file_path: 'n.txt', old_string: 'b', new_string: 'Z' })).toEqual({ ok: true, text: 'Edited n.txt.' })
    expect(readFileSync(join(dir, 'n.txt'), 'utf8')).toBe('aZc')
  })

  it('glob and grep', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'x.ts'), 'one\ntwo needle\n')
    writeFileSync(join(dir, 'y.md'), 'needle')
    const t = make(approvingGate(pathOf))
    expect((await t.vo_glob({ pattern: '**/*.ts' })).text).toBe('sub/x.ts')
    expect((await t.vo_glob({ pattern: '*.zip' })).text).toBe('No files found.')
    expect((await t.vo_grep({ pattern: 'needle', output_mode: 'content' })).text).toBe('sub/x.ts:2:two needle\ny.md:1:needle')
    expect((await t.vo_grep({ pattern: 'NEEDLE', '-i': true })).text).toBe('sub/x.ts\ny.md')
    expect((await t.vo_grep({ pattern: 'needle', path: 'sub' })).text).toBe('sub/x.ts')
    expect((await t.vo_grep({ pattern: 'nothing' })).text).toBe('No matches found.')
  })

  it.each(['denied', 'denied_by_policy', 'expired', 'cancelled', 'stale_approval', 'revoked'] as const)('maps gate outcome %s', async (o) => {
    const t = make(denyGate(o))
    const r = await t.vo_read({ file_path: 'a.txt' })
    expect(r).toEqual({ ok: false, error: o, text: RESULT_TEXT[o] })
  })

  it.each(['not_found', 'unsafe_path', 'not_unique', 'too_large'] as const)('maps FileOpFailure %s', async (code) => {
    const throwing: ToolGate = { async use() { throw new FileOpFailure(code) } }
    expect(await make(throwing).vo_read({ file_path: 'a' })).toEqual({ ok: false, error: code, text: RESULT_TEXT[code] })
  })

  it('real FileOpFailure from perform maps to its code, other errors to failed', async () => {
    const t = make(approvingGate(pathOf))
    expect(await t.vo_read({ file_path: 'missing.txt' })).toEqual({ ok: false, error: 'not_found', text: RESULT_TEXT.not_found })
    const boom: ToolGate = { async use() { throw new Error(`boom ${dir} ${MARKER}`) } }
    expect(await make(boom).vo_read({ file_path: 'a' })).toEqual({ ok: false, error: 'failed', text: RESULT_TEXT.failed })
  })

  it('fails closed without workspace or paths', async () => {
    const noWs = make(approvingGate(pathOf, () => null))
    expect(errorOf(await noWs.vo_read({ file_path: 'a.txt' }))).toBe('failed')
    expect(errorOf(await noWs.vo_glob({ pattern: '*' }))).toBe('failed')
    const noPaths = make(approvingGate(() => []))
    expect(errorOf(await noPaths.vo_read({ file_path: 'a.txt' }))).toBe('failed')
    expect(errorOf(await noPaths.vo_write({ file_path: 'a.txt', content: 'x' }))).toBe('failed')
    expect(errorOf(await noPaths.vo_grep({ pattern: 'x', path: 'sub' }))).toBe('failed')
    expect(readdirSync(dir)).toEqual([])
  })

  it('derives the target from checked paths, not raw input', async () => {
    writeFileSync(join(dir, 'real.txt'), 'right')
    const t = make(approvingGate(() => [{ arg: 'file_path', relative: 'real.txt' }]))
    const r = await t.vo_read({ file_path: '../../etc/passwd' })
    expect(r.text).toBe('right')
  })

  it('invalid input does not call the gate', async () => {
    const t = make(approvingGate(pathOf))
    for (const f of [t.vo_read, t.vo_glob, t.vo_grep, t.vo_write, t.vo_edit, t.vo_run]) {
      for (const bad of [null, 'str', 3, undefined, [1]]) {
        expect(await f(bad)).toEqual({ ok: false, error: 'invalid_input', text: RESULT_TEXT.invalid_input })
      }
    }
    expect(calls).toEqual([])
  })

  it('vo_run never performs anything even when approved', async () => {
    const spy = vi.fn()
    const gate: ToolGate = { async use<T>(r: ToolRequest, perform: (a: GatedAction) => Promise<T> | T) {
      calls.push(r)
      spy()
      const value = await perform({ tool: 'Bash', input: r.input, workspace: { id: 'w', path: dir }, signal: new AbortController().signal, paths: [] })
      return { behavior: 'allow' as const, outcome: 'approved' as const, value }
    } }
    const before = readdirSync(dir)
    const r = await make(gate).vo_run({ command: `touch ${join(dir, 'pwned')} ${MARKER}` })
    expect(r).toEqual({ ok: false, error: 'not_supported', text: RESULT_TEXT.not_supported })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(readdirSync(dir)).toEqual(before)
  })

  it('no result text contains the workspace path or input content', async () => {
    writeFileSync(join(dir, 'a.txt'), 'plain')
    const outcomes = ['denied', 'denied_by_policy', 'expired', 'cancelled', 'stale_approval', 'revoked'] as const
    const inputs: Array<[keyof ReturnType<typeof make>, unknown]> = [
      ['vo_read', { file_path: `a.txt`, offset: 1 }],
      ['vo_glob', { pattern: `${MARKER}*` }],
      ['vo_grep', { pattern: MARKER }],
      ['vo_write', { file_path: 'w.txt', content: MARKER }],
      ['vo_edit', { file_path: 'a.txt', old_string: MARKER, new_string: MARKER }],
      ['vo_run', { command: MARKER }],
      ['vo_read', { file_path: `${MARKER}.txt` }],
    ]
    const all: string[] = Object.values(RESULT_TEXT)
    for (const [name, input] of inputs) {
      const results = [await make(approvingGate(pathOf))[name](input), await make({ async use() { throw new Error(`${dir}${MARKER}`) } })[name](input)]
      for (const o of outcomes) results.push(await make(denyGate(o))[name](input))
      for (const r of results) {
        if (!r.ok) expect(r.text).toBe(RESULT_TEXT[r.error])
        expect(r.text).not.toContain(dir)
        expect(r.text).not.toContain(MARKER)
      }
    }
    for (const s of all) { expect(s).not.toContain(dir); expect(s).not.toContain('/') }
    const codes: ToolErrorCode[] = Object.keys(RESULT_TEXT) as ToolErrorCode[]
    expect(codes).toHaveLength(19)
  })

  it('raw input paths are ignored by every path tool', async () => {
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'f.txt'), 'needle here')
    const at = (relative: string) => make(approvingGate(() => [{ arg: 'x', relative }]))
    expect((await at('real').vo_glob({ pattern: '*.txt', path: '../../..' })).text).toBe('real/f.txt')
    expect((await at('real').vo_grep({ pattern: 'needle', path: '/etc' })).text).toBe('real/f.txt')
    expect(await at('w.txt').vo_write({ file_path: '/etc/evil', content: 'q' })).toEqual({ ok: true, text: 'Wrote 1 bytes to w.txt.' })
    expect(readFileSync(join(dir, 'w.txt'), 'utf8')).toBe('q')
    expect(await at('w.txt').vo_edit({ file_path: '../../x', old_string: 'q', new_string: 'r' })).toEqual({ ok: true, text: 'Edited w.txt.' })
    expect(readFileSync(join(dir, 'w.txt'), 'utf8')).toBe('r')
  })

  it('redacts secrets in grep matches, including ones near the line cut', async () => {
    const key = 'AIza' + 'Sy' + 'abcdefghijklmnopqrstuvwxyz0123456'.slice(0, 33)
    writeFileSync(join(dir, 'g.txt'), 'x'.repeat(174) + ' ' + key + ' tail needle\n' + 'needle sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n')
    const r = await make(approvingGate(pathOf)).vo_grep({ pattern: 'needle', output_mode: 'content' })
    expect(r.text).not.toContain(key.slice(4, 16))
    expect(r.text).not.toContain('AIza')
    expect(r.text).not.toContain('sk-ant')
  })

  it('redacts secrets that straddle the read cut', async () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP'
    writeFileSync(join(dir, 'r.txt'), 'a'.repeat(65536 - 9) + ' ' + key + '\n' + 'b'.repeat(100))
    const r = await make(approvingGate(pathOf)).vo_read({ file_path: 'r.txt' })
    expect(r.text).not.toContain('AKIA')
    expect(r.text).not.toContain('ABCDEFGH')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEowIBAAKCAQEA'.repeat(40) + '\n-----END RSA PRIVATE KEY-----\n'
    writeFileSync(join(dir, 'p.txt'), 'a'.repeat(65536 - 100) + '\n' + pem + 'tail')
    const p = await make(approvingGate(pathOf)).vo_read({ file_path: 'p.txt' })
    expect(p.text).not.toContain('MIIEow')
    expect(p.text).not.toContain('BEGIN RSA')
  })

  it('validates required fields before calling the gate', async () => {
    const t = make(approvingGate(pathOf))
    const bad: Array<[((i: unknown) => Promise<ToolResult>), unknown]> = [
      [t.vo_read, { file_path: 5 }], [t.vo_read, { file_path: 'a', offset: 0 }], [t.vo_read, { file_path: 'a', limit: 1.5 }], [t.vo_read, { file_path: 'a', offset: '2' }],
      [t.vo_glob, {}], [t.vo_grep, {}], [t.vo_grep, { pattern: 1 }],
      [t.vo_write, { file_path: 'a' }], [t.vo_write, { content: 'x' }],
      [t.vo_edit, { file_path: 'a', old_string: 'x' }], [t.vo_edit, { file_path: 'a', new_string: 'x' }],
    ]
    for (const [f, input] of bad) expect(await f(input)).toEqual({ ok: false, error: 'invalid_input', text: RESULT_TEXT.invalid_input })
    expect(calls).toEqual([])
  })

  it('fails closed on unexpected gate results', async () => {
    const weird: unknown[] = [undefined, null, { behavior: 'allow', outcome: 'allowed', value: 5 }, { behavior: 'allow', outcome: 'allowed' }, { behavior: 'deny', outcome: 'bogus', message: 'x' }, { behavior: 'huh' }]
    for (const w of weird) {
      const gate = { async use() { return w } } as unknown as ToolGate
      expect(await make(gate).vo_read({ file_path: 'a' })).toEqual({ ok: false, error: 'failed', text: RESULT_TEXT.failed })
    }
  })

  it('only marks truncation when the slice reaches the cap', async () => {
    writeFileSync(join(dir, 's.txt'), 'one\ntwo\n' + 'z'.repeat(70000))
    const r = await make(approvingGate(pathOf)).vo_read({ file_path: 's.txt', limit: 2 })
    expect(r.text).toBe('one\ntwo')
  })
})
