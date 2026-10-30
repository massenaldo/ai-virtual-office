import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Workspaces: named folders under one root that an agent may work in. The browser only ever names one by id; paths are
// resolved here, from the server's own config, and never leave the server.
//
// Guaranteed: at the moment of each check, the workspace's real path is inside the root's real path, and a candidate
// path, with every existing component's symlinks resolved, is inside the workspace. A dangling symlink is never
// accepted as a target.
// Not guaranteed: time of check to time of use. A process with write access to the root could swap a component between
// a check and the runtime's own file operation. These checks are a policy, not a sandbox: every task start and every
// tool decision re-checks, and a runtime must re-check at use time (see the Claude provider notes).
// A path that names the workspace through an unresolved alias (for example /var/... instead of /private/var/...) fails
// the lexical step and is denied. That is deny-by-default.

export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const MAX_WORKSPACES = 32
export const MAX_PATH_CHARS = 4096

export type WorkspaceEntry = { id: string; relativePath: string }
/** path is a real path and stays on the server. */
export type ResolvedWorkspace = { id: string; path: string }
export type WorkspaceReason = 'not_configured' | 'invalid_id' | 'unknown' | 'missing' | 'escapes_root'
export type WorkspaceConfig = { workspaceRoot: string | null; workspaces: WorkspaceEntry[] }
export type PathReason = 'invalid_path' | 'outside_workspace' | 'unsafe_symlink'

export function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** The real location of a path that may not exist yet: the real path of its deepest existing ancestor plus the rest. */
function realLocation(path: string): string {
  let cur = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(path)
      rest.push(basename(cur))
      cur = parent
    }
  }
}

const isDirectory = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

/** Config-time check of WORKSPACE_ROOT and WORKSPACES. Every problem is collected; a bad root skips the entries. */
export function parseWorkspaces(rootRaw: string | undefined, listRaw: string | undefined, dataDir: string): { workspaceRoot: string | null; workspaces: WorkspaceEntry[]; errors: string[] } {
  const none = { workspaceRoot: null, workspaces: [] as WorkspaceEntry[] }
  if (rootRaw === undefined && listRaw === undefined) return { ...none, errors: [] }
  if (rootRaw === undefined) return { ...none, errors: ['WORKSPACES needs WORKSPACE_ROOT.'] }
  if (!isAbsolute(rootRaw)) return { ...none, errors: [`WORKSPACE_ROOT must be an absolute path (got "${rootRaw}").`] }
  let rootReal: string
  try {
    rootReal = realpathSync(rootRaw)
    if (!statSync(rootReal).isDirectory()) throw new Error('not a directory')
  } catch {
    return { ...none, errors: [`WORKSPACE_ROOT must be an existing directory (got "${rootRaw}").`] }
  }
  if (rootReal === sep) return { ...none, errors: ['WORKSPACE_ROOT must not be the filesystem root.'] }
  if (listRaw === undefined) return { workspaceRoot: rootReal, workspaces: [], errors: [] }

  const entries = listRaw.split(',').map((e) => e.trim()).filter((e) => e !== '')
  if (entries.length > MAX_WORKSPACES) return { workspaceRoot: rootReal, workspaces: [], errors: [`WORKSPACES lists more than ${MAX_WORKSPACES} workspaces.`] }

  const errors: string[] = []
  const workspaces: WorkspaceEntry[] = []
  const reals: Array<{ id: string; real: string }> = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const cut = entry.indexOf(':')
    if (cut < 0) { errors.push(`WORKSPACES entry "${entry}" must look like id:relative/path.`); continue }
    const id = entry.slice(0, cut).trim()
    const path = entry.slice(cut + 1).trim()
    if (!WORKSPACE_ID_RE.test(id)) { errors.push(`Workspace id "${id}" must be 1–32 lowercase letters, digits or hyphens, starting with a letter or digit.`); continue }
    if (seen.has(id)) { errors.push(`Workspace id "${id}" is listed twice.`); continue }
    seen.add(id)
    if (path === '' || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) { errors.push(`Workspace "${id}" path must be relative to WORKSPACE_ROOT (got "${path}").`); continue }
    if (path.includes('\0') || path.includes('\\')) { errors.push(`Workspace "${id}" path contains a forbidden character.`); continue }
    if (path.split('/').includes('..')) { errors.push(`Workspace "${id}" path must not contain "..".`); continue }
    let real: string
    try {
      real = realpathSync(join(rootReal, path))
    } catch {
      errors.push(`Workspace "${id}" must be an existing directory under WORKSPACE_ROOT (got "${path}").`)
      continue
    }
    if (!isDirectory(real)) { errors.push(`Workspace "${id}" must be an existing directory under WORKSPACE_ROOT (got "${path}").`); continue }
    if (!isInside(rootReal, real)) { errors.push(`Workspace "${id}" resolves outside WORKSPACE_ROOT.`); continue }
    workspaces.push({ id, relativePath: path })
    reals.push({ id, real })
  }

  // An agent must never be able to edit the data file or the audit log.
  if (errors.length === 0) {
    const data = realLocation(dataDir)
    const hit = reals.find((w) => isInside(w.real, data))
    if (hit) errors.push(`DATA_DIR must not be inside workspace "${hit.id}".`)
  }
  return { workspaceRoot: rootReal, workspaces, errors }
}

/** Looks the id up in the server's own list and re-checks the real paths now; never cached. */
export function resolveWorkspace(config: WorkspaceConfig, workspaceId: unknown): { ok: true; workspace: ResolvedWorkspace } | { ok: false; reason: WorkspaceReason } {
  if (config.workspaceRoot === null) return { ok: false, reason: 'not_configured' }
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return { ok: false, reason: 'invalid_id' }
  const entry = config.workspaces.find((w) => w.id === workspaceId)
  if (!entry) return { ok: false, reason: 'unknown' }
  let rootNow: string
  let real: string
  try {
    rootNow = realpathSync(config.workspaceRoot)
    real = realpathSync(join(rootNow, entry.relativePath))
    if (!statSync(real).isDirectory()) return { ok: false, reason: 'missing' }
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!isInside(rootNow, real)) return { ok: false, reason: 'escapes_root' }
  return { ok: true, workspace: { id: entry.id, path: real } }
}

/** Is `candidate` (relative to the workspace, or absolute) inside it once symlinks are resolved? workspacePath must be a real path. */
export function checkPathInWorkspace(workspacePath: string, candidate: unknown): { ok: true; relative: string } | { ok: false; reason: PathReason } {
  // NUL is rejected before any filesystem call: Node throws ERR_INVALID_ARG_VALUE for it, not ENOENT.
  if (typeof candidate !== 'string' || candidate === '' || candidate.length > MAX_PATH_CHARS || candidate.includes('\0') || candidate.includes('\\')) return { ok: false, reason: 'invalid_path' }
  // A `..` after a symlink is resolved by the kernel against the link's target, but resolve() below removes it textually,
  // so `link/../x` would be judged by the wrong path. No `..` segment is ever accepted, even one that stays inside.
  if (candidate.split('/').includes('..')) return { ok: false, reason: 'outside_workspace' }
  const abs = resolve(workspacePath, candidate)
  if (!isInside(workspacePath, abs)) return { ok: false, reason: 'outside_workspace' }
  let cur = abs
  for (;;) {
    try {
      if (!isInside(workspacePath, realpathSync(cur))) return { ok: false, reason: 'outside_workspace' }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // If something exists at `cur` it is a dangling symlink: never a safe target.
        try {
          lstatSync(cur)
          return { ok: false, reason: 'unsafe_symlink' }
        } catch {
          const parent = dirname(cur)
          if (parent === cur) return { ok: false, reason: 'invalid_path' }
          cur = parent
          continue
        }
      }
      if (code === 'ELOOP') return { ok: false, reason: 'unsafe_symlink' }
      return { ok: false, reason: 'invalid_path' }
    }
  }
  return { ok: true, relative: relative(workspacePath, abs) || '.' }
}
