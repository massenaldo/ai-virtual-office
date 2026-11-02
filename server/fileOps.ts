import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { isInside, MAX_PATH_CHARS } from './workspaces'

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
  if (typeof relative !== 'string' || relative.length > MAX_PATH_CHARS || relative.includes('\0') || relative.includes('\\') || relative.startsWith('/')) throw new FileOpFailure('unsafe_path')
  const parts = relative.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new FileOpFailure('unsafe_path')
  return parts
}

/**
 * Opens a path inside the workspace and returns a descriptor the caller must close. `flags` are the caller's open flags
 * (O_NOFOLLOW is always added); with O_DIRECTORY this opens a directory, so a caller that needs a file's parent can use
 * `openInside(ws, parentRelative, O_RDONLY | O_DIRECTORY, ...)` and an empty path is the workspace itself.
 * workspacePath must be a real path.
 */
export function openInside(workspacePath: string, relative: string, flags: number, signal: AbortSignal, hooks?: OpenHooks): number {
  checkAborted(signal)
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
      // A missing final component is fine (the caller may be creating it); anything that exists must not be a symlink.
      try {
        const st = lstatSync(target)
        if (st.isSymbolicLink()) throw new FileOpFailure('unsafe_path')
        if (wantDir && !st.isDirectory()) throw new FileOpFailure('not_a_directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    checkAborted(signal)
    hooks?.beforeOpen?.()
    fd = openSync(target, flags | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    let now: Stats
    try { now = lstatSync(target) } catch { throw new FileOpFailure('unsafe_path') }
    if (now.isSymbolicLink() || now.dev !== opened.dev || now.ino !== opened.ino) throw new FileOpFailure('unsafe_path')
    // The descriptor may have been reached through a component swapped for a symlink after the walk.
    if (!isInside(workspacePath, realpathSync(parentPath))) throw new FileOpFailure('unsafe_path')
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
export function readTextFile(workspacePath: string, relative: string, signal: AbortSignal): { text: string; truncated: boolean; bytes: number } {
  const fd = openInside(workspacePath, relative, constants.O_RDONLY, signal)
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
    if (truncated) while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
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
