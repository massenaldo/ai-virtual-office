import { isInside } from './workspaces'

// Paths no tool may touch, whatever the workspace or the permission rules say. Matching is per path segment and
// case-insensitive (the default macOS file system is), so `src/env.ts` and `gitignore.txt` are fine but `sub/.ENV` is not.

const SENSITIVE_NAMES: ReadonlySet<string> = new Set(['.git', '.ssh', '.aws', '.npmrc', '.netrc', 'credentials.json'])
const SENSITIVE_PREFIXES: readonly string[] = ['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']
const SENSITIVE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx']

function sensitiveSegment(segment: string): boolean {
  const s = segment.toLowerCase()
  return SENSITIVE_NAMES.has(s) || SENSITIVE_PREFIXES.some((p) => s.startsWith(p)) || SENSITIVE_EXTENSIONS.some((e) => s.endsWith(e))
}

/** True when any segment of a workspace-relative path names a secret, a key, a credential file or a git directory. */
export function isSensitiveRelative(relative: string): boolean {
  return relative.split(/[\\/]+/).some(sensitiveSegment)
}

/** True when a glob could name such a path: a segment (or brace/alternation branch) that starts `.env` or is `.git`. */
export function globReachesSensitive(pattern: string): boolean {
  const p = pattern.toLowerCase()
  return /(^|[/{,(|@!])\.env/.test(p) || /(^|[/{,(|@!])\.git($|[/},)|])/.test(p) || pattern.split('/').some((s) => sensitiveSegment(s))
}

/** True when an absolute path is one of the protected roots or inside one (for example the server's data directory). */
export function isProtectedAbsolute(absolute: string, roots: readonly string[]): boolean {
  return roots.some((r) => isInside(r, absolute))
}
