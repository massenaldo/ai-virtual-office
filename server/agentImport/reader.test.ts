import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAgentFile, readAgentFiles } from './reader'

let ws: string
let outside: string
const signal = new AbortController().signal
const doc = (name: string) => `---\nname: ${name}\n---\nBody\n`
const agents = () => join(ws, '.claude', 'agents')

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'ai-ws-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ai-out-')))
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('readAgentFiles', () => {
  it('reports a missing folder', () => {
    expect(readAgentFiles(ws, signal)).toEqual({ folder: 'missing', files: [], cut: false })
  })
  it('reports a symlinked folder as refused, not missing', () => {
    mkdirSync(join(ws, '.claude'), { recursive: true })
    symlinkSync(outside, agents())
    expect(readAgentFiles(ws, signal)).toEqual({ folder: 'refused', files: [], cut: false })
  })
  it('lists only .md files directly inside, sorted', () => {
    mkdirSync(join(agents(), 'sub.md'), { recursive: true })
    writeFileSync(join(agents(), 'b.md'), doc('B'))
    writeFileSync(join(agents(), 'a.md'), doc('A'))
    writeFileSync(join(agents(), 'notes.txt'), 'x')
    const r = readAgentFiles(ws, signal)
    expect(r.folder).toBe('found')
    expect(r.files.map((f) => f.file)).toEqual(['a.md', 'b.md'])
    expect(r.files.every((f) => f.ok)).toBe(true)
  })
  it('gives a per-file error for an odd file name', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(agents(), '-bad.md'), doc('X'))
    writeFileSync(join(agents(), 'sp ace.md'), doc('X'))
    const r = readAgentFiles(ws, signal)
    expect(r.files).toHaveLength(2)
    expect(r.files.every((f) => !f.ok)).toBe(true)
  })
  it('refuses a symlinked .claude', () => {
    mkdirSync(join(outside, 'agents'), { recursive: true })
    writeFileSync(join(outside, 'agents', 'a.md'), doc('Leak'))
    symlinkSync(outside, join(ws, '.claude'))
    const r = readAgentFiles(ws, signal)
    expect(JSON.stringify(r)).not.toContain('Leak')
    expect(r.files).toEqual([])
  })
  it('refuses a symlinked agents folder', () => {
    mkdirSync(join(ws, '.claude'))
    mkdirSync(join(outside, 'x'))
    writeFileSync(join(outside, 'x', 'a.md'), doc('Leak'))
    symlinkSync(join(outside, 'x'), agents())
    const r = readAgentFiles(ws, signal)
    expect(JSON.stringify(r)).not.toContain('Leak')
    expect(r.files).toEqual([])
  })
  it('refuses a symlinked file', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(outside, 'a.md'), doc('Leak'))
    symlinkSync(join(outside, 'a.md'), join(agents(), 'a.md'))
    const r = readAgentFiles(ws, signal)
    expect(JSON.stringify(r)).not.toContain('Leak')
    expect(r.files[0]?.ok).toBe(false)
  })
  it('refuses a hard-linked file', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(outside, 'a.md'), doc('Leak'))
    linkSync(join(outside, 'a.md'), join(agents(), 'a.md'))
    const r = readAgentFiles(ws, signal)
    expect(JSON.stringify(r)).not.toContain('Leak')
    expect(r.files[0]?.ok).toBe(false)
  })
  it('refuses a file over 65536 bytes', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(agents(), 'big.md'), `---\nname: Big\n---\n${'x'.repeat(65537)}`)
    const r = readAgentFiles(ws, signal)
    expect(r.files[0]?.ok).toBe(false)
  })
  it('keeps the first 50 files', () => {
    mkdirSync(agents(), { recursive: true })
    for (let i = 0; i < 52; i++) writeFileSync(join(agents(), `a${String(i).padStart(2, '0')}.md`), doc(`A${i}`))
    const r = readAgentFiles(ws, signal)
    expect(r.files).toHaveLength(50)
    expect(r.cut).toBe(true)
    expect(r.files[0]!.file).toBe('a00.md')
  })
  it('digests the exact bytes', () => {
    mkdirSync(agents(), { recursive: true })
    const text = '\uFEFF' + doc('A').replace(/\n/g, '\r\n')
    writeFileSync(join(agents(), 'a.md'), text)
    const first = readAgentFiles(ws, signal).files[0]!
    expect(first.digest).toBe(createHash('sha256').update(Buffer.from(text)).digest('hex'))
    writeFileSync(join(agents(), 'a.md'), doc('B'))
    expect(readAgentFiles(ws, signal).files[0]!.digest).not.toBe(first.digest)
  })
})

describe('readAgentFiles hardening', () => {
  it('never echoes a refused file name', () => {
    mkdirSync(agents(), { recursive: true })
    const names = ['b\u202Eetadpu.md', 'line\nbreak.md', '\u001b[31mred.md', 'ghp_' + 'a'.repeat(36) + '!.md', 'x'.repeat(200) + '.md']
    for (const n of names) writeFileSync(join(agents(), n), doc('X'))
    const r = readAgentFiles(ws, signal)
    expect(r.files).toHaveLength(names.length)
    for (const f of r.files) {
      expect(f.ok).toBe(false)
      expect(f.file).toMatch(/^[ -~]*$/)
      expect(f.file).not.toMatch(/ghp_|\n/)
      if (!f.ok) expect(f.error).toMatch(/not allowed/)
    }
  })
  it('gives failed reads an empty digest', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(agents(), 'bad.md'), 'no front matter')
    writeFileSync(join(agents(), 'big.md'), 'x'.repeat(65537))
    const files = readAgentFiles(ws, signal).files
    expect(files.map((f) => f.file)).toEqual(['bad.md', 'big.md'])
    for (const f of files) { expect(f.ok).toBe(false); expect(f.file === 'big.md' ? f.digest === '' : f.digest.length === 64).toBe(true) }
    expect(files.find((f) => f.file === 'big.md')?.digest).toBe('')
  })
  it('refuses a FIFO without blocking', () => {
    mkdirSync(agents(), { recursive: true })
    execFileSync('mkfifo', [join(agents(), 'pipe.md')])
    const r = readAgentFiles(ws, signal)
    expect(r.files[0]).toMatchObject({ file: 'pipe.md', ok: false, digest: '' })
    expect(readAgentFile(ws, 'pipe.md', signal)?.ok).toBe(false)
  })
})

describe('readAgentFile', () => {
  it('reads one file, and null when it is not there or the name is bad', () => {
    mkdirSync(agents(), { recursive: true })
    writeFileSync(join(agents(), 'a.md'), doc('A'))
    const f = readAgentFile(ws, 'a.md', signal)
    expect(f?.ok).toBe(true)
    expect(readAgentFile(ws, 'gone.md', signal)).toBeNull()
    expect(readAgentFile(ws, '../a.md', signal)).toBeNull()
    expect(readAgentFile(ws, 'sub/a.md', signal)).toBeNull()
  })
})
