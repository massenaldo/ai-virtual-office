import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerConfig } from './config'
import type { Logger } from './log'
import { ruleState } from './permissions/engine'
import type { PermissionRule } from './permissions/types'
import { foldName } from './sensitivePaths'
import { resolveWorkspace, isInside } from './workspaces'

// What the Claude runtime cannot check for itself: who the server runs as and what else that user can reach. The agent's tools
// are policy-checked, but the child process and the server share one operating-system user, so a flaw anywhere would run with that
// user's privileges. These checks make the worst setups impossible to start by accident. They are not a sandbox.
// Checked whenever the claude runtime is registered (RUNTIME=claude or ENABLE_CLAUDE_RUNTIME=yes); the mock runs nothing.

export type HostFacts = {
  /** True when the claude provider is registered: RUNTIME=claude or ENABLE_CLAUDE_RUNTIME=yes. */
  claudeEnabled: boolean
  /** The effective user id; null where the platform has none. */
  uid: number | null
  allowRoot: boolean
  dataDir: string
  /** The permission bits of the data folder, or null if it does not exist yet. */
  dataDirMode: number | null
  /** The application's own folder (the repository), as a real path. */
  projectDir: string
  /** The server user's home folder, as a real path. */
  home: string
  /** WORKSPACE_ROOT as a real path, or null when none is set. */
  workspaceRoot: string | null
  /** Each workspace's id and real path. */
  workspaces: Array<{ id: string; path: string }>
  /** Names of credential folders and files found in the server user's home, for example `.ssh`. */
  homeCredentials: string[]
}

export type HostCheck = { refuse: string[]; warn: string[] }

/** Credential stores that sit in a home folder. The server user's agent session shares that user, so their presence is worth saying out loud. */
export const HOME_CREDENTIALS = ['.ssh', '.aws', '.config/gcloud', '.azure', '.kube', '.docker/config.json', '.git-credentials', '.netrc', '.npmrc', '.gnupg'] as const

export function checkHost(f: HostFacts): HostCheck {
  const refuse: string[] = []
  const warn: string[] = []
  if (!f.claudeEnabled) return { refuse, warn }
  // A case-insensitive file system treats /Users/Me and /users/me as one folder, so every comparison is on folded names.
  const inside = (parent: string, child: string): boolean => isInside(foldName(parent), foldName(child))

  if (f.uid === 0 && !f.allowRoot) {
    refuse.push('Refusing to run RUNTIME=claude as root. Run the server as a dedicated unprivileged user (see docs/os-user-hardening.md), or set VO_ALLOW_ROOT=yes if you accept that the agent then runs with root\'s privileges.')
  }
  for (const w of f.workspaces) {
    if (inside(w.path, f.projectDir)) {
      refuse.push(`Workspace "${w.id}" contains the application's own folder, so the agent could change the server's code and settings. Point the workspace at a folder that does not contain this project.`)
    }
  }
  for (const w of f.workspaces) {
    if (inside(w.path, f.home)) {
      refuse.push(`Workspace "${w.id}" contains the server user's home folder, which holds personal files and credentials. Use a folder made for the agent.`)
    }
    if (f.workspaceRoot !== null && foldName(w.path) === foldName(f.workspaceRoot)) {
      refuse.push(`Workspace "${w.id}" is the whole workspace root. Give each workspace its own folder under WORKSPACE_ROOT.`)
    }
  }
  for (let i = 0; i < f.workspaces.length; i++) {
    for (let j = i + 1; j < f.workspaces.length; j++) {
      const a = f.workspaces[i]!
      const b = f.workspaces[j]!
      if (inside(a.path, b.path) || inside(b.path, a.path)) {
        refuse.push(`Workspaces "${a.id}" and "${b.id}" overlap, so a grant or a change in one reaches the other. Give each its own folder.`)
      }
    }
  }
  if (f.dataDirMode !== null && (f.dataDirMode & 0o077) !== 0) {
    warn.push(`The data folder is readable by other users (mode ${(f.dataDirMode & 0o777).toString(8)}). It holds the API token, the audit log and the agent's state: run chmod 700 on it.`)
  }
  if (f.homeCredentials.length > 0 && f.uid !== 0) {
    warn.push(`The user running the server has credentials in its home folder (${f.homeCredentials.join(', ')}). The agent's tools cannot reach them, but a flaw would run as this user. Prefer a dedicated user (docs/os-user-hardening.md).`)
  }
  return { refuse, warn }
}

/** Reads the facts from this process and the config. Nothing here changes anything. */
export function readHostFacts(config: ServerConfig, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): HostFacts {
  let dataDirMode: number | null = null
  try { dataDirMode = statSync(config.dataDir).mode & 0o777 } catch { dataDirMode = null }
  let projectDir = cwd
  try { projectDir = realpathSync.native(cwd) } catch { /* keep the given path */ }
  const workspaces: HostFacts['workspaces'] = []
  for (const entry of config.workspaces) {
    const resolved = resolveWorkspace(config, entry.id)
    if (resolved.ok) workspaces.push({ id: resolved.workspace.id, path: resolved.workspace.path })
  }
  const homeRaw = env.HOME ?? homedir()
  let home = homeRaw
  try { home = realpathSync.native(homeRaw) } catch { /* keep the given path */ }
  const homeCredentials = HOME_CREDENTIALS.filter((name) => existsSync(join(home, name)))
  return { claudeEnabled: config.runtime === 'claude' || config.enableClaudeRuntime, uid: typeof process.getuid === 'function' ? process.getuid() : null, allowRoot: env.VO_ALLOW_ROOT === 'yes', dataDir: config.dataDir, dataDirMode, projectDir, home, workspaceRoot: config.workspaceRoot, workspaces, homeCredentials: [...homeCredentials] }
}

/** For the entry points: logs every finding and returns false when the server must not start. */
export function enforceHostSafety(config: ServerConfig, log: Logger, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): boolean {
  const { refuse, warn } = checkHost(readHostFacts(config, env, cwd))
  for (const message of warn) log.warn(message)
  for (const message of refuse) log.error(message)
  return refuse.length === 0
}


/** Agent and task rules that allow Write or Edit in every workspace: made before rules were bound to a workspace. */
export function countUnboundWriteRules(rules: readonly PermissionRule[], at: string): number {
  return rules.filter((r) => (r.scope === 'agent' || r.scope === 'task') && r.effect === 'allow' && (r.tool === 'Write' || r.tool === 'Edit') && r.workspaceId === null && ruleState(r, at) === 'active').length
}

export const UNBOUND_WRITE_RULES_WARNING = (count: number): string =>
  `${count} active agent or task permission ${count === 1 ? 'rule allows' : 'rules allow'} file writes in every workspace (they were made before workspace binding). Review and revoke them in the permissions panel.`
