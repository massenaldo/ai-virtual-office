import { constants, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, closeSync, fstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FILE_READ_MAX_BYTES, FileOpFailure, openInside, readTextFile, type FileOpError } from './fileOps'

let base: string
let ws: string
let outside: string
const live = new AbortController().signal

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'fileops-')))
  ws = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(ws)
  mkdirSync(outside)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

function code(fn: () => unknown): FileOpError | 'no error' {
  try { fn() } catch (e) {
    if (e instanceof FileOpFailure) { expect(e.message).toBe(e.code); expect(e.message).not.toContain(base); return e.code }
    throw e
  }
  return 'no error'
}

describe('readTextFile', () => {
  it('reads a normal file', () => {
    writeFileSync(join(ws, 'a.txt'), 'héllo')
    expect(readTextFile(ws, 'a.txt', live)).toEqual({ text: 'héllo', truncated: false, bytes: 6 })
  })
  it('reads nested files and tolerates empty and . components', () => {
    mkdirSync(join(ws, 'd'))
    writeFileSync(join(ws, 'd', 'a.txt'), 'x')
    expect(readTextFile(ws, 'd//./a.txt', live).text).toBe('x')
    expect(readTextFile(ws, './d/a.txt/', live).text).toBe('x')
  })
  it('truncates at the cap; bytes is what was returned', () => {
    writeFileSync(join(ws, 'big.txt'), 'a'.repeat(FILE_READ_MAX_BYTES + 100))
    const r = readTextFile(ws, 'big.txt', live)
    expect(r.truncated).toBe(true)
    expect(r.bytes).toBe(FILE_READ_MAX_BYTES)
    expect(r.text.length).toBe(FILE_READ_MAX_BYTES)
  })
  it('does not split a multi-byte character when truncating', () => {
    writeFileSync(join(ws, 'u.txt'), 'a'.repeat(FILE_READ_MAX_BYTES - 1) + 'é' + 'b')
    const r = readTextFile(ws, 'u.txt', live)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('a'.repeat(FILE_READ_MAX_BYTES - 1))
    expect(r.bytes).toBe(FILE_READ_MAX_BYTES - 1)
  })
  it('a file of exactly the cap is not truncated', () => {
    writeFileSync(join(ws, 'e.txt'), 'a'.repeat(FILE_READ_MAX_BYTES))
    expect(readTextFile(ws, 'e.txt', live).truncated).toBe(false)
  })
  it('missing file is not_found; missing parent too', () => {
    expect(code(() => readTextFile(ws, 'nope.txt', live))).toBe('not_found')
    expect(code(() => readTextFile(ws, 'nope/x.txt', live))).toBe('not_found')
  })
  it('a directory is not_a_file', () => {
    mkdirSync(join(ws, 'd'))
    expect(code(() => readTextFile(ws, 'd', live))).toBe('not_a_file')
    expect(code(() => readTextFile(ws, '.', live))).toBe('not_a_file')
  })
  it('a file used as a directory component is not_a_directory', () => {
    writeFileSync(join(ws, 'f'), 'x')
    expect(code(() => readTextFile(ws, 'f/x', live))).toBe('not_a_directory')
  })
  it('a NUL byte is not_text; invalid UTF-8 too', () => {
    writeFileSync(join(ws, 'bin'), Buffer.from([65, 0, 66]))
    writeFileSync(join(ws, 'bad'), Buffer.from([0xff, 0xfe, 0x41]))
    expect(code(() => readTextFile(ws, 'bin', live))).toBe('not_text')
    expect(code(() => readTextFile(ws, 'bad', live))).toBe('not_text')
  })
  it('a symlink as the final component is unsafe_path', () => {
    writeFileSync(join(outside, 's.txt'), 'secret')
    symlinkSync(join(outside, 's.txt'), join(ws, 'l.txt'))
    expect(code(() => readTextFile(ws, 'l.txt', live))).toBe('unsafe_path')
  })
  it('a symlink to a file inside the workspace is also refused', () => {
    writeFileSync(join(ws, 'real.txt'), 'x')
    symlinkSync(join(ws, 'real.txt'), join(ws, 'l.txt'))
    expect(code(() => readTextFile(ws, 'l.txt', live))).toBe('unsafe_path')
  })
  it('a dangling symlink as the final component is unsafe_path', () => {
    symlinkSync(join(outside, 'gone'), join(ws, 'dangling'))
    expect(code(() => readTextFile(ws, 'dangling', live))).toBe('unsafe_path')
  })
  it('a symlinked directory component is unsafe_path', () => {
    writeFileSync(join(outside, 's.txt'), 'secret')
    symlinkSync(outside, join(ws, 'dir'))
    expect(code(() => readTextFile(ws, 'dir/s.txt', live))).toBe('unsafe_path')
  })
  it('a hard-linked file is unsafe_path', () => {
    writeFileSync(join(outside, 'h.txt'), 'secret')
    linkSync(join(outside, 'h.txt'), join(ws, 'h.txt'))
    expect(code(() => readTextFile(ws, 'h.txt', live))).toBe('unsafe_path')
  })
  it('an aborted signal is aborted before any open', () => {
    writeFileSync(join(ws, 'a.txt'), 'x')
    const c = new AbortController()
    c.abort()
    expect(code(() => readTextFile(ws, 'a.txt', c.signal))).toBe('aborted')
    let called = false
    expect(code(() => openInside(ws, 'a.txt', constants.O_RDONLY, c.signal, { beforeOpen: () => { called = true } }))).toBe('aborted')
    expect(called).toBe(false)
  })
  it('refuses .., absolute paths and NUL', () => {
    writeFileSync(join(base, 'up.txt'), 'x')
    expect(code(() => readTextFile(ws, '../up.txt', live))).toBe('unsafe_path')
    expect(code(() => readTextFile(ws, join(ws, 'a.txt'), live))).toBe('unsafe_path')
    expect(code(() => readTextFile(ws, 'a\0b', live))).toBe('unsafe_path')
    expect(code(() => readTextFile(ws, '', live))).toBe('not_a_file')
  })
})

describe('openInside', () => {
  it('swap test: a directory replaced by a symlink before the open is unsafe_path', () => {
    mkdirSync(join(ws, 'dir'))
    writeFileSync(join(ws, 'dir', 's.txt'), 'inside')
    writeFileSync(join(outside, 's.txt'), 'secret')
    let swapped = false
    const c = code(() => openInside(ws, 'dir/s.txt', constants.O_RDONLY, live, {
      beforeOpen: () => {
        renameSync(join(ws, 'dir'), join(ws, 'dir.old'))
        symlinkSync(outside, join(ws, 'dir'))
        swapped = true
      },
    }))
    expect(swapped).toBe(true)
    expect(c).toBe('unsafe_path')
  })
  it('swap test: the final file replaced by a symlink is unsafe_path', () => {
    writeFileSync(join(ws, 'a.txt'), 'x')
    writeFileSync(join(outside, 's.txt'), 'secret')
    const c = code(() => openInside(ws, 'a.txt', constants.O_RDONLY, live, {
      beforeOpen: () => { renameSync(join(ws, 'a.txt'), join(ws, 'a.old')); symlinkSync(join(outside, 's.txt'), join(ws, 'a.txt')) },
    }))
    expect(c).toBe('unsafe_path')
  })
  it('returns a usable descriptor', () => {
    writeFileSync(join(ws, 'a.txt'), 'abc')
    const fd = openInside(ws, 'a.txt', constants.O_RDONLY, live)
    try { expect(fstatSync(fd).size).toBe(3) } finally { closeSync(fd) }
  })
  it('opens a directory with O_DIRECTORY, for a caller that needs a parent (empty path is the workspace)', () => {
    mkdirSync(join(ws, 'd'))
    for (const rel of ['d', '', '.']) {
      const fd = openInside(ws, rel, constants.O_RDONLY | constants.O_DIRECTORY, live)
      try { expect(fstatSync(fd).isDirectory()).toBe(true) } finally { closeSync(fd) }
    }
    writeFileSync(join(ws, 'f'), 'x')
    expect(code(() => openInside(ws, 'f', constants.O_RDONLY | constants.O_DIRECTORY, live))).toBe('not_a_directory')
  })
  it('a symlinked directory is refused even with O_DIRECTORY', () => {
    symlinkSync(outside, join(ws, 'dir'))
    expect(code(() => openInside(ws, 'dir', constants.O_RDONLY | constants.O_DIRECTORY, live))).toBe('unsafe_path')
  })
  it('can create a missing final component when asked to', () => {
    const fd = openInside(ws, 'new.txt', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, live)
    closeSync(fd)
    expect(readTextFile(ws, 'new.txt', live).text).toBe('')
  })
})
