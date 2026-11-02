import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REVIEW_MAX_BYTES } from '../src/workforce/types'
import { FILE_READ_MAX_BYTES, FileOpFailure, GLOB_MAX_RESULTS, GREP_MAX_FILE_BYTES, GREP_MAX_MATCHES, GREP_MAX_TOTAL_BYTES, TRAVERSAL_MAX_ENTRIES, editTextFile, globFiles, grepFiles, openInside, readTextFile, writeTextFile, type FileOpError } from './fileOps'

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
    expect(readTextFile(ws, './d/a.txt', live).text).toBe('x')
    expect(code(() => readTextFile(ws, 'd/a.txt/', live))).toBe('unsafe_path')
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
  it('refuses creating, truncating, appending and writing flags before touching the filesystem', () => {
    writeFileSync(join(ws, 'keep.txt'), 'keep')
    for (const f of [constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, constants.O_RDONLY | constants.O_CREAT, constants.O_WRONLY, constants.O_RDWR, constants.O_RDONLY | constants.O_TRUNC, constants.O_RDONLY | constants.O_APPEND]) {
      expect(code(() => openInside(ws, 'new.txt', f, live))).toBe('unsafe_path')
      expect(code(() => openInside(ws, 'keep.txt', f, live))).toBe('unsafe_path')
    }
    expect(code(() => readTextFile(ws, 'new.txt', live))).toBe('not_found')
    expect(readTextFile(ws, 'keep.txt', live).text).toBe('keep')
  })
  it.skipIf(process.platform === 'win32')('a FIFO is not_a_file and does not block', () => {
    execFileSync('mkfifo', [join(ws, 'pipe')])
    expect(code(() => readTextFile(ws, 'pipe', live))).toBe('not_a_file')
  })
  it('a parent swapped for a symlink to another folder inside the workspace is unsafe_path', () => {
    mkdirSync(join(ws, 'a'))
    mkdirSync(join(ws, 'other'))
    writeFileSync(join(ws, 'a', 'f.txt'), 'x')
    writeFileSync(join(ws, 'other', 'f.txt'), 'y')
    const c = code(() => openInside(ws, 'a/f.txt', constants.O_RDONLY, live, {
      beforeOpen: () => { renameSync(join(ws, 'a'), join(ws, 'a.old')); symlinkSync(join(ws, 'other'), join(ws, 'a')) },
    }))
    expect(c).toBe('unsafe_path')
  })
  it('readTextFile never returns content reached through a swapped directory', () => {
    mkdirSync(join(ws, 'dir'))
    writeFileSync(join(ws, 'dir', 's.txt'), 'inside')
    writeFileSync(join(outside, 's.txt'), 'secret')
    let result: unknown
    const c = code(() => { result = readTextFile(ws, 'dir/s.txt', live, { beforeOpen: () => { renameSync(join(ws, 'dir'), join(ws, 'dir.old')); symlinkSync(outside, join(ws, 'dir')) } }) })
    expect(c).toBe('unsafe_path')
    expect(result).toBeUndefined()
  })
})

const tmps = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('writeTextFile', () => {
  it('creates a file and reports bytes and created', () => {
    expect(writeTextFile(ws, 'a.txt', 'héllo', live)).toEqual({ bytes: 6, created: true })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('héllo')
    expect(statSync(join(ws, 'a.txt')).mode & 0o777).toBe(0o600)
    expect(tmps(ws)).toEqual([])
  })
  it('overwrites, keeps the existing mode, reports created false', () => {
    writeFileSync(join(ws, 'a.txt'), 'old')
    chmodSync(join(ws, 'a.txt'), 0o640)
    expect(writeTextFile(ws, 'a.txt', 'new', live)).toEqual({ bytes: 3, created: false })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('new')
    expect(statSync(join(ws, 'a.txt')).mode & 0o777).toBe(0o640)
    expect(tmps(ws)).toEqual([])
  })
  it('writes in an existing subdirectory; a missing parent is not_found and not created', () => {
    mkdirSync(join(ws, 'd'))
    writeTextFile(ws, 'd/a.txt', 'x', live)
    expect(readFileSync(join(ws, 'd', 'a.txt'), 'utf8')).toBe('x')
    expect(code(() => writeTextFile(ws, 'nope/a.txt', 'x', live))).toBe('not_found')
    expect(readdirSync(ws)).toEqual(['d'])
  })
  it('content over REVIEW_MAX_BYTES (bytes, not chars) is too_large and nothing is written', () => {
    expect(code(() => writeTextFile(ws, 'a.txt', 'é'.repeat(REVIEW_MAX_BYTES / 2 + 1), live))).toBe('too_large')
    expect(readdirSync(ws)).toEqual([])
    expect(writeTextFile(ws, 'ok.txt', 'a'.repeat(REVIEW_MAX_BYTES), live).bytes).toBe(REVIEW_MAX_BYTES)
  })
  it('refuses an empty path, .., absolute and symlink targets', () => {
    writeFileSync(join(outside, 's.txt'), 'secret')
    symlinkSync(join(outside, 's.txt'), join(ws, 'l.txt'))
    expect(code(() => writeTextFile(ws, '', 'x', live))).toBe('not_a_file')
    expect(code(() => writeTextFile(ws, '../x.txt', 'x', live))).toBe('unsafe_path')
    expect(code(() => writeTextFile(ws, 'l.txt', 'x', live))).toBe('unsafe_path')
    expect(readFileSync(join(outside, 's.txt'), 'utf8')).toBe('secret')
    expect(tmps(ws)).toEqual([])
  })
  it('a dangling symlink target is unsafe_path and creates nothing outside', () => {
    symlinkSync(join(outside, 'gone'), join(ws, 'dangling'))
    expect(code(() => writeTextFile(ws, 'dangling', 'x', live))).toBe('unsafe_path')
    expect(readdirSync(outside)).toEqual([])
  })
  it('a hard-linked target is unsafe_path and the outside inode is untouched', () => {
    writeFileSync(join(outside, 'h.txt'), 'secret')
    linkSync(join(outside, 'h.txt'), join(ws, 'h.txt'))
    expect(code(() => writeTextFile(ws, 'h.txt', 'x', live))).toBe('unsafe_path')
    expect(readFileSync(join(outside, 'h.txt'), 'utf8')).toBe('secret')
    expect(tmps(ws)).toEqual([])
  })
  it('a directory target is not_a_file; a file as a parent is not_a_directory', () => {
    mkdirSync(join(ws, 'd'))
    writeFileSync(join(ws, 'f'), 'x')
    expect(code(() => writeTextFile(ws, 'd', 'x', live))).toBe('not_a_file')
    expect(code(() => writeTextFile(ws, 'f/x', 'x', live))).toBe('not_a_directory')
    expect(tmps(ws)).toEqual([])
  })
  it('a symlinked parent directory is unsafe_path', () => {
    symlinkSync(outside, join(ws, 'dir'))
    expect(code(() => writeTextFile(ws, 'dir/a.txt', 'x', live))).toBe('unsafe_path')
    expect(readdirSync(outside)).toEqual([])
  })
  it('an aborted signal writes nothing', () => {
    const c = new AbortController()
    c.abort()
    expect(code(() => writeTextFile(ws, 'a.txt', 'x', c.signal))).toBe('aborted')
    expect(readdirSync(ws)).toEqual([])
  })
  it('abort between the temp write and the rename keeps the original and leaves no temp file', () => {
    writeFileSync(join(ws, 'a.txt'), 'original')
    const c = new AbortController()
    expect(code(() => writeTextFile(ws, 'a.txt', 'new', c.signal, { beforeRename: () => c.abort() }))).toBe('aborted')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('original')
    expect(tmps(ws)).toEqual([])
  })
  it('a parent swapped for a symlink after the temp file is created writes nothing outside', () => {
    mkdirSync(join(ws, 'dir'))
    writeFileSync(join(ws, 'dir', 'a.txt'), 'original')
    const c = code(() => writeTextFile(ws, 'dir/a.txt', 'new', live, {
      beforeRename: () => { renameSync(join(ws, 'dir'), join(ws, 'dir.old')); symlinkSync(outside, join(ws, 'dir')) },
    }))
    expect(c).toBe('unsafe_path')
    expect(readdirSync(outside)).toEqual([])
    expect(readFileSync(join(ws, 'dir.old', 'a.txt'), 'utf8')).toBe('original')
  })
  it('a parent swapped right after the temp file is created is unsafe_path and nothing lands outside', () => {
    mkdirSync(join(ws, 'dir'))
    const c = code(() => writeTextFile(ws, 'dir/a.txt', 'new', live, {
      afterTempCreate: () => { renameSync(join(ws, 'dir'), join(ws, 'dir.old')); symlinkSync(outside, join(ws, 'dir')) },
    }))
    expect(c).toBe('unsafe_path')
    expect(readdirSync(outside)).toEqual([])
  })
  it('the temp file replaced by a symlink is unsafe_path and nothing is written through it', () => {
    writeFileSync(join(outside, 's.txt'), 'secret')
    const c = code(() => writeTextFile(ws, 'a.txt', 'new', live, {
      afterTempCreate: () => {
        const t = tmps(ws)[0]!
        rmSync(join(ws, t))
        symlinkSync(join(outside, 's.txt'), join(ws, t))
      },
    }))
    expect(c).toBe('unsafe_path')
    expect(readFileSync(join(outside, 's.txt'), 'utf8')).toBe('secret')
    expect(readdirSync(ws).filter((n) => n === 'a.txt')).toEqual([])
  })
  it('two writers to one file leave one complete winner and no temp files', () => {
    writeFileSync(join(ws, 'a.txt'), 'original')
    writeTextFile(ws, 'a.txt', 'first first first', live, {
      beforeRename: () => { writeTextFile(ws, 'a.txt', 'second', live); expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('second'); expect(tmps(ws).length).toBe(1) },
    })
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('first first first')
    expect(tmps(ws)).toEqual([])
  })
})

describe('editTextFile', () => {
  const edit = (old: string, neu: string, all = false) => editTextFile(ws, 'a.txt', old, neu, all, live)
  const put = (s: string) => writeFileSync(join(ws, 'a.txt'), s)
  const get = () => readFileSync(join(ws, 'a.txt'), 'utf8')
  it('replaces a unique match', () => {
    put('one two three')
    expect(edit('two', '2')).toEqual({ replacements: 1 })
    expect(get()).toBe('one 2 three')
  })
  it('zero matches and an empty old string are no_match', () => {
    put('abc')
    expect(code(() => edit('zzz', 'x'))).toBe('no_match')
    expect(code(() => edit('', 'x'))).toBe('no_match')
    expect(get()).toBe('abc')
  })
  it('two matches without replaceAll are not_unique and the file is unchanged', () => {
    put('a b a')
    expect(code(() => edit('a', 'x'))).toBe('not_unique')
    expect(get()).toBe('a b a')
  })
  it('replaceAll replaces every match and counts them; replacement text is literal', () => {
    put('a b a')
    expect(edit('a', '$&$1', true)).toEqual({ replacements: 2 })
    expect(get()).toBe('$&$1 b $&$1')
  })
  it('keeps the file mode', () => {
    put('abc')
    chmodSync(join(ws, 'a.txt'), 0o640)
    edit('b', 'x')
    expect(statSync(join(ws, 'a.txt')).mode & 0o777).toBe(0o640)
  })
  it('a file over the read cap is too_large, not truncated', () => {
    put('a'.repeat(FILE_READ_MAX_BYTES + 10))
    expect(code(() => edit('a', 'b', true))).toBe('too_large')
    expect(get().length).toBe(FILE_READ_MAX_BYTES + 10)
  })
  it('a result over REVIEW_MAX_BYTES is too_large and the file is unchanged', () => {
    put('x' + 'a'.repeat(REVIEW_MAX_BYTES - 1))
    expect(code(() => edit('x', 'yy'))).toBe('too_large')
    expect(get().length).toBe(REVIEW_MAX_BYTES)
  })
  it('missing, symlinked and hard-linked files are refused', () => {
    expect(code(() => edit('a', 'b'))).toBe('not_found')
    writeFileSync(join(outside, 's.txt'), 'secret')
    symlinkSync(join(outside, 's.txt'), join(ws, 'l.txt'))
    linkSync(join(outside, 's.txt'), join(ws, 'h.txt'))
    expect(code(() => editTextFile(ws, 'l.txt', 's', 'x', false, live))).toBe('unsafe_path')
    expect(code(() => editTextFile(ws, 'h.txt', 's', 'x', false, live))).toBe('unsafe_path')
    expect(readFileSync(join(outside, 's.txt'), 'utf8')).toBe('secret')
  })
  it('abort before rename keeps the original', () => {
    put('abc')
    const c = new AbortController()
    expect(code(() => editTextFile(ws, 'a.txt', 'b', 'x', false, c.signal, { beforeRename: () => c.abort() }))).toBe('aborted')
    expect(get()).toBe('abc')
    expect(tmps(ws)).toEqual([])
  })
  it('keeps a leading BOM through an edit', () => {
    put('\uFEFFabc')
    expect(readTextFile(ws, 'a.txt', live).text).toBe('\uFEFFabc')
    edit('b', 'x')
    expect(readFileSync(join(ws, 'a.txt')).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(get()).toBe('\uFEFFaxc')
  })
  it('a lone surrogate is refused: no_match for old, not_text for new', () => {
    put('abc')
    expect(code(() => edit('\ud800', 'x'))).toBe('no_match')
    expect(code(() => edit('b', '\udc00'))).toBe('not_text')
    expect(get()).toBe('abc')
  })
})

describe('writeTextFile hardening', () => {
  it('never carries setuid, setgid or sticky bits', () => {
    for (const m of [0o4755, 0o2755, 0o1755]) {
      writeFileSync(join(ws, 'a.txt'), 'old')
      chmodSync(join(ws, 'a.txt'), m)
      writeTextFile(ws, 'a.txt', 'new', live)
      expect(statSync(join(ws, 'a.txt')).mode & 0o7777).toBe(0o755)
    }
  })
  it('a hard link to the temp file made after creation is unsafe_path', () => {
    writeFileSync(join(ws, 'a.txt'), 'original')
    const c = code(() => writeTextFile(ws, 'a.txt', 'new', live, { afterTempCreate: () => linkSync(join(ws, tmps(ws)[0]!), join(outside, 'l')) }))
    expect(c).toBe('unsafe_path')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('original')
    expect(tmps(ws)).toEqual([])
  })
  it('a hard link to the temp file made just before the rename is unsafe_path', () => {
    writeFileSync(join(ws, 'a.txt'), 'original')
    const c = code(() => writeTextFile(ws, 'a.txt', 'new', live, { beforeRename: () => linkSync(join(ws, tmps(ws)[0]!), join(outside, 'l')) }))
    expect(c).toBe('unsafe_path')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('original')
    expect(tmps(ws)).toEqual([])
  })
  it('a very long file name is bounded in the temp name and refused cleanly by the OS', () => {
    const c = code(() => writeTextFile(ws, 'a'.repeat(300), 'x', live))
    expect(['unsafe_path', 'no error']).toContain(c)
    expect(tmps(ws)).toEqual([])
  })
})

describe('globFiles and grepFiles', () => {
  const put = (rel: string, content = 'x') => {
    const abs = join(ws, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  const gl = (pattern: string, baseRel = '', roots: string[] = []) => globFiles(ws, baseRel, pattern, live, roots)
  const gr = (pattern: string, o: { glob?: string; ignoreCase?: boolean; mode?: 'content' | 'files_with_matches' } = {}, baseRel = '', roots: string[] = []) =>
    grepFiles(ws, baseRel, pattern, { ignoreCase: false, mode: 'content', ...o }, live, roots)

  it('glob returns sorted workspace-relative files, relative to the base', () => {
    put('b.ts'); put('a.ts'); put('src/z.ts'); put('src/deep/y.ts'); put('src/n.md')
    expect(gl('**/*.ts').paths).toEqual(['a.ts', 'b.ts', 'src/deep/y.ts', 'src/z.ts'])
    expect(gl('**/*.ts', 'src')).toEqual({ paths: ['src/deep/y.ts', 'src/z.ts'], truncated: false })
    expect(gl('*.ts', '.').paths).toEqual(['a.ts', 'b.ts'])
  })
  it('never returns sensitive files or protected roots, even when named, for glob and grep', () => {
    put('.env', 'SECRET'); put('.git/config', 'SECRET'); put('k/id_rsa', 'SECRET'); put('c.pem', 'SECRET'); put('ok.txt', 'SECRET')
    put('data/store.json', 'SECRET')
    const roots = [join(ws, 'data')]
    expect(gl('**', '', roots).paths).toEqual(['ok.txt'])
    expect(gl('.env', '', roots).paths).toEqual([])
    expect(gl('.git/**', '', roots).paths).toEqual([])
    expect(gr('SECRET', {}, '', roots).matches.map((m) => m.path)).toEqual(['ok.txt'])
    expect(gl('**', '.git').paths).toEqual([])
  })
  it('skips symlinked files and directories', () => {
    put('real/a.txt', 'needle'); writeFileSync(join(outside, 'o.txt'), 'needle')
    symlinkSync(join(outside, 'o.txt'), join(ws, 'link.txt'))
    symlinkSync(outside, join(ws, 'linkdir'))
    expect(gl('**').paths).toEqual(['real/a.txt'])
    expect(gr('needle').matches.map((m) => m.path)).toEqual(['real/a.txt'])
  })
  it('refuses a base that is a symlink, outside, missing or a file', () => {
    put('f.txt'); symlinkSync(outside, join(ws, 'ln'))
    expect(code(() => gl('**', 'ln'))).toBe('unsafe_path')
    expect(code(() => gl('**', '../outside'))).toBe('unsafe_path')
    expect(code(() => gl('**', 'nope'))).toBe('not_found')
    expect(code(() => gl('**', 'f.txt'))).toBe('not_a_directory')
  })
  it('rejects invalid patterns', () => {
    expect(code(() => gl('../*'))).toBe('unsafe_path')
    expect(code(() => gl('{a,b}'))).toBe('unsafe_path')
    expect(code(() => gr('x', { glob: '/abs' }))).toBe('unsafe_path')
  })
  it('caps glob results', () => {
    for (let i = 0; i < GLOB_MAX_RESULTS + 5; i++) put(`d/f${String(i).padStart(4, '0')}.txt`, '')
    const r = gl('**/*.txt')
    expect(r.paths).toHaveLength(GLOB_MAX_RESULTS)
    expect(r.truncated).toBe(true)
  })
  it('stops the traversal at the entry cap', () => {
    for (let i = 0; i < TRAVERSAL_MAX_ENTRIES + 20; i++) put(`m/f${i}.log`, '')
    const r = gl('**/*.log')
    expect(r.truncated).toBe(true)
    expect(r.paths.length).toBeLessThanOrEqual(GLOB_MAX_RESULTS)
  })
  it('aborts', () => {
    put('a.txt')
    const ac = new AbortController(); ac.abort()
    expect(code(() => globFiles(ws, '', '**', ac.signal, []))).toBe('aborted')
    expect(code(() => grepFiles(ws, '', 'x', { ignoreCase: false, mode: 'content' }, ac.signal, []))).toBe('aborted')
  })
  it('grep matches a fixed string and numbers lines', () => {
    put('a.txt', 'one\ntwo (a+)+$\nthree'); put('b.txt', 'none')
    expect(gr('(a+)+$').matches).toEqual([{ path: 'a.txt', line: 2, text: 'two (a+)+$' }])
    expect(gr('o').matches.map((m) => `${m.path}:${m.line}`)).toEqual(['a.txt:1', 'a.txt:2', 'b.txt:1'])
  })
  it('grep ignoreCase, files_with_matches and glob filter', () => {
    put('a.txt', 'Hello\nhello'); put('b.md', 'HELLO')
    expect(gr('hello').matches).toHaveLength(1)
    expect(gr('hello', { ignoreCase: true }).matches).toHaveLength(3)
    expect(gr('hello', { ignoreCase: true, mode: 'files_with_matches' }).matches).toEqual([{ path: 'a.txt', line: 0, text: '' }, { path: 'b.md', line: 0, text: '' }])
    expect(gr('hello', { ignoreCase: true, glob: '**/*.md' }).matches.map((m) => m.path)).toEqual(['b.md'])
  })
  it('grep skips binary, oversized and invalid UTF-8 files', () => {
    put('bin.dat', 'needle\0x'); put('big.txt', 'needle' + 'a'.repeat(GREP_MAX_FILE_BYTES)); writeFileSync(join(ws, 'bad.txt'), Buffer.from([0x6e, 0xff, 0xfe]))
    put('good.txt', 'needle')
    expect(gr('needle').matches.map((m) => m.path)).toEqual(['good.txt'])
  })
  it('grep skips hard-linked files', () => {
    put('a.txt', 'needle'); linkSync(join(ws, 'a.txt'), join(ws, 'b.txt'))
    expect(gr('needle').matches).toEqual([])
  })
  it('grep caps matches and cuts long lines', () => {
    put('a.txt', ('x'.repeat(300) + '\n').repeat(GREP_MAX_MATCHES + 10))
    const r = gr('x')
    expect(r.matches).toHaveLength(GREP_MAX_MATCHES)
    expect(r.truncated).toBe(true)
    expect(r.matches[0]!.text).toHaveLength(200)
  })
  it('grep is not vulnerable to catastrophic patterns', () => {
    put('a.txt', 'a'.repeat(1024 * 1024))
    const t = Date.now()
    expect(gr('(a+)+$').matches).toEqual([])
    expect(Date.now() - t).toBeLessThan(250)
  })
  it('a directory swapped for a symlink before it is listed leaks nothing', () => {
    put('d/a.txt', 'needle'); writeFileSync(join(outside, 'secret-name.txt'), 'needle')
    const swap = (rel: string) => {
      if (rel !== 'd') return
      renameSync(join(ws, 'd'), join(base, 'moved'))
      symlinkSync(outside, join(ws, 'd'))
    }
    expect(globFiles(ws, '', '**', live, [], { beforeReaddir: swap }).paths).toEqual([])
    rmSync(join(ws, 'd')); renameSync(join(base, 'moved'), join(ws, 'd'))
    const r = grepFiles(ws, '', 'needle', { ignoreCase: false, mode: 'content' }, live, [], { beforeReaddir: swap })
    expect(r.matches).toEqual([])
  })
  it('a base directory swapped before listing is skipped', () => {
    put('d/a.txt'); writeFileSync(join(outside, 'o.txt'), 'x')
    const swap = (rel: string) => { if (rel === 'd') { renameSync(join(ws, 'd'), join(base, 'moved')); symlinkSync(outside, join(ws, 'd')) } }
    expect(globFiles(ws, 'd', '**', live, [], { beforeReaddir: swap }).paths).toEqual([])
  })
  it('aborts part-way through a walk', () => {
    put('a/x.txt'); put('b/y.txt')
    const ac = new AbortController()
    expect(code(() => globFiles(ws, '', '**', ac.signal, [], { beforeReaddir: (rel) => { if (rel === 'b') ac.abort() } }))).toBe('aborted')
  })
  it('grep stops at the total byte budget', () => {
    for (const n of ['a', 'b', 'c', 'd']) put(`${n}.txt`, 'needle' + 'z'.repeat(994))
    const r = grepFiles(ws, '', 'needle', { ignoreCase: false, mode: 'files_with_matches' }, live, [], { limits: { maxTotalBytes: 2500 } })
    expect(r.matches.map((m) => m.path)).toEqual(['a.txt', 'b.txt'])
    expect(r.truncated).toBe(true)
    expect(GREP_MAX_TOTAL_BYTES).toBe(33554432)
  })
  it('catches case variants and nested repositories', () => {
    put('.ENV', 'SECRET'); put('.Git/config', 'SECRET'); put('pkg/.git/config', 'SECRET'); put('ok.txt', 'SECRET')
    expect(gl('**').paths).toEqual(['ok.txt'])
    expect(gr('SECRET').matches.map((m) => m.path)).toEqual(['ok.txt'])
  })
  it('grep ignores sensitive globs and sensitive or protected bases with a fixed empty result', () => {
    put('.env', 'SECRET'); put('.git/config', 'SECRET'); put('data/s.txt', 'SECRET')
    expect(gr('SECRET', { glob: '.env' }).matches).toEqual([])
    expect(gr('SECRET', { glob: '**/.git/**' }).matches).toEqual([])
    expect(gr('SECRET', {}, '.git')).toEqual({ matches: [], truncated: false })
    expect(gr('SECRET', {}, 'missing/.git')).toEqual({ matches: [], truncated: false })
    expect(gl('**', '.git/x')).toEqual({ paths: [], truncated: false })
    expect(gr('SECRET', {}, 'data', [join(ws, 'data')])).toEqual({ matches: [], truncated: false })
  })
  it('is not truncated when the result count equals the cap exactly', () => {
    for (let i = 0; i < GLOB_MAX_RESULTS; i++) put(`d/f${i}.txt`, '')
    expect(gl('**/*.txt')).toMatchObject({ truncated: false })
    expect(gl('**/*.txt').paths).toHaveLength(GLOB_MAX_RESULTS)
  })
  it('cuts a long line without splitting a surrogate pair', () => {
    put('a.txt', 'x'.repeat(199) + '\u{1F600}tail')
    const text = gr('tail').matches[0]!.text
    expect(text).toBe('x'.repeat(199))
  })
})
