import { isInside } from './workspaces'

// Paths no tool may touch, whatever the workspace or the permission rules say. Matching is per path segment and
// case-insensitive (the default macOS file system is), so `src/env.ts` and `gitignore.txt` are fine but `sub/.ENV` is not.

const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  '.git', '.ssh', '.aws', '.npmrc', '.netrc', 'credentials.json', '.gnupg', '.kube', '.docker', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd',
  '.credentials.json', '.vault-token', '.s3cfg', '.boto', 'kubeconfig', '.azure', 'secrets.yml', 'secrets.yaml', 'secrets.json',
])
const SENSITIVE_PREFIXES: readonly string[] = ['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']
const SENSITIVE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.tfvars', '.tfstate', '_history']
// A folder name that is only sensitive under a given parent (`.config/gh` holds hosts.yml with a token).
const SENSITIVE_UNDER: ReadonlyArray<readonly [string, string]> = [['.config', 'gh'], ['.config', 'gcloud']]

/**
 * One fold for every name comparison. NFKC maps `ſ` to `s` and the Kelvin sign to `k`; the upper/lower round trip folds `ß`.
 * Case-insensitive file systems fold names this way, so comparing anything less lets `.ſsh` through.
 */
export function foldName(s: string): string {
  return s.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase()
}

function sensitiveSegment(segment: string): boolean {
  const s = foldName(segment)
  return SENSITIVE_NAMES.has(s) || SENSITIVE_PREFIXES.some((p) => s.startsWith(p)) || SENSITIVE_EXTENSIONS.some((e) => s.endsWith(e)) || s.includes('.tfstate.') || s.includes('.tfvars.')
}

function sensitiveSegments(segments: readonly string[]): boolean {
  const folded = segments.map(foldName)
  return segments.some(sensitiveSegment) || folded.some((s, i) => SENSITIVE_UNDER.some(([parent, child]) => s === parent && folded[i + 1] === child))
}

/** True when any segment of a workspace-relative path names a secret, a key, a credential file or a git directory. */
export function isSensitiveRelative(relative: string): boolean {
  return sensitiveSegments(relative.split(/[\\/]+/))
}

/** True when a glob could name such a path: a segment (or brace/alternation branch) that starts `.env` or is `.git`. */
export function globReachesSensitive(pattern: string): boolean {
  const p = foldName(pattern)
  return /(^|[/{,(|@!])\.env/.test(p) || /(^|[/{,(|@!])\.git($|[/},)|])/.test(p) || sensitiveSegments(pattern.split('/'))
}

/** True when an absolute path is one of the protected roots or inside one (for example the server's data directory). */
export function isProtectedAbsolute(absolute: string, roots: readonly string[]): boolean {
  return roots.some((r) => isInside(foldName(r), foldName(absolute)))
}
