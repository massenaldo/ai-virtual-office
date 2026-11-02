import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_MAX_BYTES } from '../src/workforce/types'
import { redactSecrets } from './redact'
import { isValidPathPattern, matchesPathPattern } from './permissions/pathPattern'
import { isProtectedAbsolute, isSensitiveRelative } from './sensitivePaths'
import { MAX_PATH_CHARS } from './workspaces'

// The filesystem layer behind the gated file tools. Node has no openat, so a path is checked component by component with
// lstat (no symlink, every parent a directory), the final component is opened with O_NOFOLLOW, and the descriptor is
// compared with a fresh lstat (dev + ino) and the parent's real path must still be inside the workspace. A directory
// swapped for a symlink between the walk and the open makes the open land outside, which the real-path check catches.
// A swap after those checks but before the caller uses the descriptor cannot redirect it: the descriptor is already bound.
// Errors are a fixed code only; no path or operating-system message ever leaves this module.

export const FILE_READ_MAX_BYTES = 65536
/** Extra bytes a redacting reader reads past FILE_READ_MAX_BYTES so a secret that straddles the cut is still matched whole. */
export const READ_REDACTION_LOOKAHEAD = 8192

export type FileOpError = 'not_found' | 'not_a_file' | 'not_a_directory' | 'unsafe_path' | 'too_large' | 'not_text' | 'not_unique' | 'no_match' | 'conflict' | 'aborted' | 'failed'

export class FileOpFailure extends Error {
  constructor(readonly code: FileOpError) {
    super(code)
    this.name = 'FileOpFailure'
  }
}

/** Test injection point: called after every path check, immediately before the final open. */
export type OpenHooks = { beforeOpen?: () => void }

function mapErrno(error: unknown): FileOpFailure {
  if (error instanceof FileOpFailure) return error
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return new FileOpFailure('not_found')
    case 'EISDIR': return new FileOpFailure('not_a_file')
    case 'ENOTDIR': return new FileOpFailure('not_a_directory')
    case 'ENAMETOOLONG': return new FileOpFailure('unsafe_path')
    case 'ELOOP': return new FileOpFailure('unsafe_path')
    default: return new FileOpFailure('failed')
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new FileOpFailure('aborted')
}

/** The components of a workspace-relative path; empty and `.` parts are dropped. `..`, NUL, `\` and absolute paths are refused. */
export function splitRelative(relative: string): string[] {
  if (typeof relative !== 'string' || relative.length > MAX_PATH_CHARS || relative.includes('\0') || relative.includes('\\') || relative.startsWith('/') || relative.endsWith('/')) throw new FileOpFailure('unsafe_path')
  const parts = relative.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new FileOpFailure('unsafe_path')
  return parts
}

const MUTATING_FLAGS = constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND | constants.O_WRONLY | constants.O_RDWR

/**
 * Opens a path inside the workspace and returns a descriptor the caller must close. This is for READ-ONLY and
 * O_DIRECTORY opens only: O_CREAT, O_TRUNC, O_APPEND, O_WRONLY and O_RDWR are refused (`unsafe_path`) before the
 * filesystem is touched, because those flags act at open time, before the identity and real-path checks can run (a
 * swapped-in symlink or hard link would already have been created or truncated). Writes use a separate temp-file design.
 * O_NOFOLLOW and O_NONBLOCK are always added (O_NONBLOCK so a FIFO cannot block the process); with O_DIRECTORY this opens a directory, so a caller that needs a file's parent can use
 * `openInside(ws, parentRelative, O_RDONLY | O_DIRECTORY, ...)` and an empty path is the workspace itself.
 * workspacePath must be a real path.
 */
export function openInside(workspacePath: string, relative: string, flags: number, signal: AbortSignal, hooks?: OpenHooks): number {
  checkAborted(signal)
  if ((flags & MUTATING_FLAGS) !== 0) throw new FileOpFailure('unsafe_path')
  let fd: number | undefined
  try {
    const parts = splitRelative(relative)
    const wantDir = (flags & constants.O_DIRECTORY) !== 0
    // Every component must be a real directory (not a symlink) while walking; the last one is checked below.
    let cur = workspacePath
    for (let i = 0; i < parts.length - 1; i++) {
      cur = join(cur, parts[i]!)
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) throw new FileOpFailure('unsafe_path')
      if (!st.isDirectory()) throw new FileOpFailure('not_a_directory')
    }
    const parentPath = cur
    const target = parts.length === 0 ? workspacePath : join(parentPath, parts[parts.length - 1]!)
    if (parts.length > 0) {
      // The final component must exist and be a regular file (or a directory when O_DIRECTORY is asked for): never a
      // symlink, FIFO, socket or device. ENOENT surfaces as not_found.
      const st = lstatSync(target)
      if (st.isSymbolicLink()) throw new FileOpFailure('unsafe_path')
      if (wantDir ? !st.isDirectory() : !st.isFile()) throw new FileOpFailure(wantDir ? 'not_a_directory' : 'not_a_file')
    }
    checkAborted(signal)
    hooks?.beforeOpen?.()
    fd = openSync(target, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    let now: Stats
    try { now = lstatSync(target) } catch { throw new FileOpFailure('unsafe_path') }
    if (now.isSymbolicLink() || now.dev !== opened.dev || now.ino !== opened.ino) throw new FileOpFailure('unsafe_path')
    // The parent's real path must be exactly the lexical path walked above: a component swapped for a symlink (to
    // outside, or to another folder inside the workspace) makes them differ. Compared case-sensitively, as realpath returns it.
    // RESIDUAL: without openat, a component swapped for a symlink and swapped back between the open and these checks is
    // not detected. It is a same-user race on a read-only descriptor (this function only opens and returns an fd; Task 3's
    // writes use a temp file and rename), so it is accepted and listed for the final review.
    if (realpathSync(parentPath) !== join(workspacePath, ...parts.slice(0, -1))) throw new FileOpFailure('unsafe_path')
    const done = fd
    fd = undefined
    return done
  } catch (error) {
    throw mapErrno(error)
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* nothing more to do */ } }
  }
}

/**
 * Reads a UTF-8 text file. `bytes` is the number of bytes of the file that were decoded into `text` (at most
 * FILE_READ_MAX_BYTES), not the file's size. When the file is longer, `truncated` is true and the cut is moved back so
 * it never splits a multi-byte character.
 */
export function readTextFile(workspacePath: string, relative: string, signal: AbortSignal, hooks?: OpenHooks, opts?: { maxBytes?: number }): { text: string; truncated: boolean; bytes: number } {
  const max = opts?.maxBytes ?? FILE_READ_MAX_BYTES
  const fd = openInside(workspacePath, relative, constants.O_RDONLY, signal, hooks)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new FileOpFailure('not_a_file')
    if (st.nlink !== 1) throw new FileOpFailure('unsafe_path')
    const buf = Buffer.alloc(max + 1)
    let got = 0
    while (got < buf.length) {
      checkAborted(signal)
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n === 0) break
      got += n
    }
    const truncated = got > max
    let end = truncated ? max : got
    if (truncated) {
      // A multi-byte character is at most 4 bytes, so at most 3 steps back; anything else is not valid text.
      for (let steps = 0; steps < 3 && end > 0 && (buf[end]! & 0xc0) === 0x80; steps++) end--
      if ((buf[end]! & 0xc0) === 0x80) throw new FileOpFailure('not_text')
    }
    const bytes = buf.subarray(0, end)
    if (bytes.includes(0)) throw new FileOpFailure('not_text')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new FileOpFailure('not_text') }
    return { text, truncated, bytes: end }
  } catch (error) {
    throw mapErrno(error)
  } finally {
    try { closeSync(fd) } catch { /* nothing more to do */ }
  }
}

/** Test injection points for writes: after the temp file is created and verified, and just before the final rename. */
export type WriteHooks = { beforeRename?: () => void; afterTempCreate?: () => void }

/**
 * Writes a UTF-8 text file atomically: a temp file in the (verified) parent directory, fsync, then rename over the
 * target. Parent directories are never created. The target, if present, must be a regular file with one link; its mode
 * is kept (a new file is 0600). Content over REVIEW_MAX_BYTES is `too_large` before anything is created. A cancelled
 * write never renames, and the temp file is always removed.
 */
export function writeTextFile(workspacePath: string, relative: string, content: string, signal: AbortSignal, hooks?: WriteHooks): { bytes: number; created: boolean } {
  checkAborted(signal)
  const data = Buffer.from(content, 'utf8')
  if (data.length > REVIEW_MAX_BYTES) throw new FileOpFailure('too_large')
  let parentFd: number | undefined
  let tmpFd: number | undefined
  let tmpPath: string | undefined
  let tmpStat: Stats | undefined
  let renamed = false
  try {
    const parts = splitRelative(relative)
    if (parts.length === 0) throw new FileOpFailure('not_a_file')
    const name = parts[parts.length - 1]!
    const parentParts = parts.slice(0, -1)
    const parentPath = join(workspacePath, ...parentParts)
    const target = join(parentPath, name)
    // The parent is opened through the same checked walk as reads; the descriptor holds its identity (dev + ino).
    parentFd = openInside(workspacePath, parentParts.join('/'), constants.O_RDONLY | constants.O_DIRECTORY, signal)
    const parentStat = fstatSync(parentFd)
    const verifyParent = (): void => {
      let now: Stats
      try { now = lstatSync(parentPath) } catch { throw new FileOpFailure('unsafe_path') }
      if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== parentStat.dev || now.ino !== parentStat.ino) throw new FileOpFailure('unsafe_path')
      if (realpathSync(parentPath) !== parentPath) throw new FileOpFailure('unsafe_path')
    }
    verifyParent()

    let mode = 0o600
    let created = true
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) throw new FileOpFailure('unsafe_path')
      if (!st.isFile()) throw new FileOpFailure('not_a_file')
      if (st.nlink !== 1) throw new FileOpFailure('unsafe_path')
      mode = st.mode & 0o777 // never carry setuid, setgid or sticky
      created = false
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }

    checkAborted(signal)
    tmpPath = join(parentPath, `.${name.slice(0, 64)}.${randomBytes(8).toString('hex')}.tmp`)
    // RESIDUAL: without openat, the parent can be swapped for a symlink between verifyParent() and this create (or
    // between the last check and the rename below); the create/rename would then land in the swapped-in directory.
    // The checks after it narrow but cannot close that window. It is a same-user race, accepted and listed for the final review.
    tmpFd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    tmpStat = fstatSync(tmpFd)
    hooks?.afterTempCreate?.()
    verifyParent()
    // Re-stat the descriptor after the hook: a hard link added to the temp file in the window shows as nlink !== 1.
    const checkTemp = (): void => {
      const fresh = fstatSync(tmpFd!)
      let onDisk: Stats
      try { onDisk = lstatSync(tmpPath!) } catch { throw new FileOpFailure('unsafe_path') }
      if (!fresh.isFile() || fresh.nlink !== 1 || onDisk.isSymbolicLink() || onDisk.dev !== tmpStat!.dev || onDisk.ino !== tmpStat!.ino) throw new FileOpFailure('unsafe_path')
    }
    checkTemp()
    fchmodSync(tmpFd, mode)

    let off = 0
    while (off < data.length) {
      checkAborted(signal)
      off += writeSync(tmpFd, data, off, data.length - off)
    }
    fsyncSync(tmpFd)
    hooks?.beforeRename?.()
    checkAborted(signal)
    verifyParent()
    checkTemp()
    // RESIDUAL: a hard link added to the temp file, or a swap of the parent after verifyParent() and before this rename is not detectable (no openat/renameat).
    renameSync(tmpPath, target)
    renamed = true
    return { bytes: data.length, created }
  } catch (error) {
    throw mapErrno(error)
  } finally {
    if (tmpFd !== undefined) { try { closeSync(tmpFd) } catch { /* nothing more to do */ } }
    if (tmpPath !== undefined && tmpStat !== undefined && !renamed) {
      // Remove only what we created: the path must still be the very file we made. If the parent was moved away
      // (a swap), the temp file went with it and cannot be reached without openat; it stays in the moved directory as a
      // hidden .tmp file. A same-user actor renaming the parent can move it anywhere they can write: residual.
      try {
        const now = lstatSync(tmpPath)
        if (now.dev === tmpStat.dev && now.ino === tmpStat.ino) unlinkSync(tmpPath)
      } catch { /* already gone */ }
    }
    if (parentFd !== undefined) { try { closeSync(parentFd) } catch { /* nothing more to do */ } }
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/**
 * Replaces `oldString` with `newString` in a UTF-8 text file. The whole file is read (over FILE_READ_MAX_BYTES is
 * `too_large`, never truncated); an empty or absent `oldString` is `no_match`; several matches without `replaceAll` is
 * `not_unique`; a result over REVIEW_MAX_BYTES is `too_large`. The write goes through writeTextFile.
 */
export function editTextFile(workspacePath: string, relative: string, oldString: string, newString: string, replaceAll: boolean, signal: AbortSignal, hooks?: WriteHooks): { replacements: number } {
  // NOTE: this is read-modify-write without compare-and-swap: a change made between the read and the rename is overwritten.
  if (LONE_SURROGATE.test(oldString)) throw new FileOpFailure('no_match')
  if (LONE_SURROGATE.test(newString)) throw new FileOpFailure('not_text')
  const { text, truncated } = readTextFile(workspacePath, relative, signal)
  if (truncated) throw new FileOpFailure('too_large')
  if (oldString === '') throw new FileOpFailure('no_match')
  const pieces = text.split(oldString)
  const count = pieces.length - 1
  if (count === 0) throw new FileOpFailure('no_match')
  if (count > 1 && !replaceAll) throw new FileOpFailure('not_unique')
  const next = pieces.join(newString)
  if (Buffer.byteLength(next, 'utf8') > REVIEW_MAX_BYTES) throw new FileOpFailure('too_large')
  writeTextFile(workspacePath, relative, next, signal, hooks)
  return { replacements: count }
}

export const GLOB_MAX_RESULTS = 500
export const GREP_MAX_MATCHES = 200
export const GREP_MAX_FILE_BYTES = 1048576
export const GREP_MAX_TOTAL_BYTES = 33554432
export const TRAVERSAL_MAX_ENTRIES = 10000
const GREP_LINE_MAX_CHARS = 200
const BINARY_SNIFF_BYTES = 8192

/** Test injection point: called after a directory is opened and verified, immediately before it is listed. */
export type WalkHooks = { beforeReaddir?: (relative: string) => void }

/**
 * Lists one directory through a verified descriptor: openInside (identity plus strict parent real path), then the
 * listing, then a fresh lstat that must still be the same directory (dev + ino, not a symlink). Any mismatch gives
 * null and the caller skips the directory, so a directory swapped for a symlink never leaks outside names.
 * A directory is read whole before the entry cap applies.
 */
function listDirectory(workspacePath: string, relative: string, signal: AbortSignal, hooks: WalkHooks | undefined, top: boolean): Dirent[] | null {
  let fd: number | undefined
  try {
    fd = openInside(workspacePath, relative, constants.O_RDONLY | constants.O_DIRECTORY, signal)
    const opened = fstatSync(fd)
    hooks?.beforeReaddir?.(relative)
    const path = relative === '' ? workspacePath : join(workspacePath, relative)
    const entries = readdirSync(path, { withFileTypes: true })
    const now = lstatSync(path)
    if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== opened.dev || now.ino !== opened.ino) return null
    return entries
  } catch (error) {
    if (error instanceof FileOpFailure && error.code === 'aborted') throw error
    if (signal.aborted) throw new FileOpFailure('aborted')
    if (top) throw mapErrno(error)
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* nothing more to do */ } }
  }
}

/**
 * Walks the files under a base directory in name order (a directory's files before its subdirectories, so a cut
 * walk yields the first entries in that order, not the lowest paths). This is the real enforcement that sensitive
 * files never show up: every entry's workspace-relative path goes through isSensitiveRelative and its absolute path
 * through isProtectedAbsolute (protectedRoots must be real paths), whatever the pattern says, and sensitive directories
 * are pruned whole. A sensitive or protected base gives an empty walk, whether or not it exists. Symlinks are skipped,
 * never followed. `visit` returns false to stop. Returns true when the entry cap cut the walk short.
 */
function walkFiles(workspacePath: string, baseRelative: string, signal: AbortSignal, protectedRoots: readonly string[], visit: (relative: string, baseRel: string) => boolean, hooks?: WalkHooks): boolean {
  const parts = splitRelative(baseRelative)
  const baseRel = parts.join('/')
  if ((baseRel !== '' && isSensitiveRelative(baseRel)) || isProtectedAbsolute(join(workspacePath, ...parts), protectedRoots)) return false
  let seen = 0
  const stack: Array<{ rel: string; top: boolean }> = [{ rel: baseRel, top: true }]
  while (stack.length > 0) {
    checkAborted(signal)
    const { rel, top } = stack.pop()!
    const entries = listDirectory(workspacePath, rel, signal, hooks, top)
    if (entries === null) continue
    checkAborted(signal)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const dirs: string[] = []
    for (const entry of entries) {
      if (++seen > TRAVERSAL_MAX_ENTRIES) return true
      if (entry.isSymbolicLink()) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (isSensitiveRelative(childRel) || isProtectedAbsolute(join(workspacePath, childRel), protectedRoots)) continue
      if (entry.isDirectory()) { dirs.push(childRel); continue }
      if (!entry.isFile()) continue
      checkAborted(signal)
      const relToBase = baseRel === '' ? childRel : childRel.slice(baseRel.length + 1)
      if (!visit(childRel, relToBase)) return false
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push({ rel: dirs[i]!, top: false })
  }
  return false
}

/** Files under `baseRelative` whose path (relative to the base) matches `pattern`; workspace-relative, sorted, capped (a truncated list is the first N in traversal order). protectedRoots must be real paths. */
export function globFiles(workspacePath: string, baseRelative: string, pattern: string, signal: AbortSignal, protectedRoots: readonly string[], hooks?: WalkHooks): { paths: string[]; truncated: boolean } {
  checkAborted(signal)
  if (!isValidPathPattern(pattern)) throw new FileOpFailure('unsafe_path')
  const paths: string[] = []
  let truncated = false
  const cut = walkFiles(workspacePath, baseRelative, signal, protectedRoots, (relative, relToBase) => {
    if (!matchesPathPattern(pattern, relToBase, true)) return true
    if (paths.length >= GLOB_MAX_RESULTS) { truncated = true; return false }
    paths.push(relative)
    return true
  }, hooks)
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { paths, truncated: truncated || cut }
}

/** At most GREP_LINE_MAX_CHARS characters, never ending in half of a surrogate pair. */
function cutLine(line: string): string {
  let end = Math.min(line.length, GREP_LINE_MAX_CHARS)
  if (end < line.length && (line.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--
  return line.slice(0, end)
}

/** Reads a file for grep through the safe open; null when it is unsafe, too large, binary or not UTF-8 (skipped, not an error). */
function readForGrep(workspacePath: string, relative: string, signal: AbortSignal, budget: { left: number; exhausted: boolean }): string | null {
  let fd: number
  try {
    fd = openInside(workspacePath, relative, constants.O_RDONLY, signal)
  } catch (error) {
    if (error instanceof FileOpFailure && error.code === 'aborted') throw error
    return null
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.size > GREP_MAX_FILE_BYTES) return null
    if (st.size > budget.left) { budget.exhausted = true; return null }
    budget.left -= st.size
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < buf.length) {
      checkAborted(signal)
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n === 0) break
      got += n
    }
    const bytes = buf.subarray(0, got)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
  } catch (error) {
    if (error instanceof FileOpFailure && error.code === 'aborted') throw error
    return null
  } finally {
    try { closeSync(fd) } catch { /* nothing more to do */ }
  }
}

/**
 * Fixed-string search (never a regular expression: a model-supplied one cannot be made safe in Node without a worker).
 * protectedRoots must be real paths. The total bytes read are capped at GREP_MAX_TOTAL_BYTES (counted from fstat before reading).
 * Matches are sorted by path then line; `files_with_matches` gives one entry per file with line 0 and empty text.
 */
export function grepFiles(
  workspacePath: string,
  baseRelative: string,
  pattern: string,
  opts: { glob?: string; ignoreCase: boolean; mode: 'content' | 'files_with_matches' },
  signal: AbortSignal,
  protectedRoots: readonly string[],
  extra?: WalkHooks & { limits?: { maxTotalBytes?: number } },
): { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean } {
  checkAborted(signal)
  if (opts.glob !== undefined && !isValidPathPattern(opts.glob)) throw new FileOpFailure('unsafe_path')
  if (pattern === '' || pattern.length > MAX_PATH_CHARS || pattern.includes('\0')) throw new FileOpFailure('no_match')
  const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern
  const matches: Array<{ path: string; line: number; text: string }> = []
  let truncated = false
  const budget = { left: extra?.limits?.maxTotalBytes ?? GREP_MAX_TOTAL_BYTES, exhausted: false }
  const cut = walkFiles(workspacePath, baseRelative, signal, protectedRoots, (relative) => {
    if (opts.glob !== undefined && !matchesPathPattern(opts.glob, relative, true)) return true
    const text = readForGrep(workspacePath, relative, signal, budget)
    if (budget.exhausted) { truncated = true; return false }
    if (text === null) return true
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const hay = opts.ignoreCase ? lines[i]!.toLowerCase() : lines[i]!
      if (!hay.includes(needle)) continue
      if (matches.length >= GREP_MAX_MATCHES) { truncated = true; return false }
      if (opts.mode === 'files_with_matches') { matches.push({ path: relative, line: 0, text: '' }); break }
      matches.push({ path: relative, line: i + 1, text: cutLine(redactSecrets(lines[i]!)) })
    }
    return true
  }, extra)
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
  return { matches, truncated: truncated || cut }
}
