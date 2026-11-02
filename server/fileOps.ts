import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { MAX_PATH_CHARS } from './workspaces'

// The filesystem layer behind the gated file tools. Node has no openat, so a path is checked component by component with
// lstat (no symlink, every parent a directory), the final component is opened with O_NOFOLLOW, and the descriptor is
// compared with a fresh lstat (dev + ino) and the parent's real path must still be inside the workspace. A directory
// swapped for a symlink between the walk and the open makes the open land outside, which the real-path check catches.
// A swap after those checks but before the caller uses the descriptor cannot redirect it: the descriptor is already bound.
// Errors are a fixed code only; no path or operating-system message ever leaves this module.

export const FILE_READ_MAX_BYTES = 65536

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
export function readTextFile(workspacePath: string, relative: string, signal: AbortSignal, hooks?: OpenHooks): { text: string; truncated: boolean; bytes: number } {
  const fd = openInside(workspacePath, relative, constants.O_RDONLY, signal, hooks)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new FileOpFailure('not_a_file')
    if (st.nlink !== 1) throw new FileOpFailure('unsafe_path')
    const buf = Buffer.alloc(FILE_READ_MAX_BYTES + 1)
    let got = 0
    while (got < buf.length) {
      checkAborted(signal)
      const n = readSync(fd, buf, got, buf.length - got, null)
      if (n === 0) break
      got += n
    }
    const truncated = got > FILE_READ_MAX_BYTES
    let end = truncated ? FILE_READ_MAX_BYTES : got
    if (truncated) {
      // A multi-byte character is at most 4 bytes, so at most 3 steps back; anything else is not valid text.
      for (let steps = 0; steps < 3 && end > 0 && (buf[end]! & 0xc0) === 0x80; steps++) end--
      if ((buf[end]! & 0xc0) === 0x80) throw new FileOpFailure('not_text')
    }
    const bytes = buf.subarray(0, end)
    if (bytes.includes(0)) throw new FileOpFailure('not_text')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new FileOpFailure('not_text') }
    return { text, truncated, bytes: end }
  } catch (error) {
    throw mapErrno(error)
  } finally {
    try { closeSync(fd) } catch { /* nothing more to do */ }
  }
}
