import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createId } from '../../src/layout/operations'
import { errorCode, type ErrorCode } from '../errorCodes'
import type { Logger } from '../log'
import { writeFileAtomic } from '../store'
import { defaultRules } from './defaults'
import { evaluate, ruleState, validateGrant } from './engine'
import { parsePermissions, PERMISSIONS_SCHEMA_VERSION, serializePermissions } from './storage'
import type { GrantError, GrantInput, PermissionDecision, PermissionQuery, PermissionRule } from './types'

export const PERMISSIONS_FILE = 'permissions.json'
export const PERMISSIONS_BACKUP_FILE = 'permissions.backup.json'

export type PermissionChange = { kind: 'granted' | 'revoked' | 'used' | 'ended' | 'expired'; rule: PermissionRule }

export type PermissionStoreOptions = {
  dataDir: string
  now: () => string
  log: Logger
  onChange?: (change: PermissionChange) => void
  /** Test seam; defaults to writeFileAtomic. */
  writeFile?: (path: string, text: string) => void
  /** `maxActive` counts rules a person or the system created (not the defaults); `maxHistory` is how many inactive ones are kept. */
  limits?: { maxActive: number; maxHistory: number }
}

export type GrantResult = { ok: true; rule: PermissionRule } | { ok: false; error: GrantError | 'limit' }
export type RevokeResult = { ok: true; rule: PermissionRule } | { ok: false; error: 'not_found' | 'inactive' }
export type PermissionLoad = { seeded: boolean; problem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null }

export type PermissionStore = {
  readonly rules: readonly PermissionRule[]
  readonly load: PermissionLoad
  readonly saveError: ErrorCode | null
  readonly filePath: string
  grant(input: GrantInput): GrantResult
  revoke(id: string): RevokeResult
  /** Revokes the agent's active agent, task and once rules. Global rules are never touched. */
  revokeForAgent(agentId: string): PermissionRule[]
  /** True exactly once, and only for an active once rule. Everything is synchronous, so two callers cannot both win. */
  consumeOnce(id: string): boolean
  endTask(taskId: string): PermissionRule[]
  /** Reports each rule that has newly expired, once. */
  sweep(): PermissionRule[]
  /** Never throws: any error is a deny. */
  evaluate(query: PermissionQuery): PermissionDecision
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const DEFAULT_LIMITS = { maxActive: 500, maxHistory: 1000 }

/**
 * The only holder of permission rules. Like the workforce store, every change is read-op-commit with no await in between;
 * memory changes first and the file follows, so a failed save never leaves a revoked rule in force.
 */
export function openPermissionStore({ dataDir, now, log, onChange, writeFile = writeFileAtomic, limits = DEFAULT_LIMITS }: PermissionStoreOptions): PermissionStore {
  mkdirSync(dataDir, { recursive: true })
  const filePath = join(dataDir, PERMISSIONS_FILE)
  const backupPath = join(dataDir, PERMISSIONS_BACKUP_FILE)
  let saveError: ErrorCode | null = null
  const logged = new Set<string>()
  const reportedExpired = new Set<string>()

  const save = (rules: readonly PermissionRule[]) => {
    try {
      writeFile(filePath, serializePermissions(rules))
      saveError = null
    } catch (error) {
      saveError = errorCode(error)
      const message = error instanceof Error ? error.message : 'Saving failed.'
      if (!logged.has(message)) {
        logged.add(message)
        log.error(`Couldn't save permissions to ${filePath}: ${message}`)
      }
    }
  }

  let text: string | null = null
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new Error(`Couldn't read ${filePath}: ${code ?? (error as Error).message}`)
  }

  let rules: PermissionRule[]
  const load: PermissionLoad = { seeded: false, problem: null, preserved: null }
  if (text === null) {
    rules = defaultRules(now())
    load.seeded = true
    save(rules)
  } else {
    let parsed: PermissionRule[] | null = null
    let raw: unknown
    try { raw = JSON.parse(text); parsed = parsePermissions(raw) } catch { parsed = null }
    if (parsed) rules = parsed
    else {
      // Never allow-all: the defaults stand, the damaged file is kept as it is until the next change replaces it.
      rules = defaultRules(now())
      load.problem = isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > PERMISSIONS_SCHEMA_VERSION ? 'unsupported-version' : 'corrupt'
      let existing: string | null = null
      try { existing = readFileSync(backupPath, 'utf8') } catch { existing = null }
      if (existing === null) {
        copyFileSync(filePath, backupPath)
        load.preserved = 'backup-created'
      } else load.preserved = existing === text ? 'backup-created' : 'backup-exists'
      log.warn(`Permission rules in ${filePath} couldn't be read (${load.problem}). Using the default rules only. ${load.preserved === 'backup-created' ? `A backup is at ${backupPath}.` : `An earlier backup already exists at ${backupPath}, so this file was not backed up and the next change replaces it.`}`)
    }
  }

  /** Drops the oldest inactive non-default rules beyond the history limit. */
  const prune = (list: PermissionRule[]): PermissionRule[] => {
    const at = now()
    const droppable = list.filter((r) => r.createdBy !== 'default' && ruleState(r, at) !== 'active')
    const drop = new Set(droppable.slice(0, Math.max(0, droppable.length - limits.maxHistory)).map((r) => r.id))
    return drop.size === 0 ? list : list.filter((r) => !drop.has(r.id))
  }

  const commit = (next: PermissionRule[], changes: PermissionChange[]) => {
    rules = prune(next)
    save(rules)
    for (const change of changes) onChange?.(change)
  }

  /** Applies `edit` to every rule that `pick` selects; returns the changed rules. */
  const update = (pick: (r: PermissionRule, at: string) => boolean, edit: (r: PermissionRule, at: string) => PermissionRule, kind: PermissionChange['kind']): PermissionRule[] => {
    const at = now()
    const changed: PermissionRule[] = []
    const next = rules.map((r) => {
      if (!pick(r, at)) return r
      const updated = edit(r, at)
      changed.push(updated)
      return updated
    })
    if (changed.length > 0) commit(next, changed.map((rule) => ({ kind, rule })))
    return changed
  }
  const isActive = (r: PermissionRule, at: string) => ruleState(r, at) === 'active'

  return {
    get rules() { return rules },
    get saveError() { return saveError },
    load,
    filePath,
    grant(input) {
      const at = now()
      const valid = validateGrant(input, at)
      if (!valid.ok) return valid
      if (rules.filter((r) => r.createdBy !== 'default' && isActive(r, at)).length >= limits.maxActive) return { ok: false, error: 'limit' }
      const rule: PermissionRule = { id: createId('perm', new Set(rules.map((r) => r.id))), createdAt: at, revokedAt: null, usedAt: null, endedAt: null, ...valid.fields }
      commit([...rules, rule], [{ kind: 'granted', rule }])
      return { ok: true, rule }
    },
    revoke(id) {
      if (!rules.some((r) => r.id === id)) return { ok: false, error: 'not_found' }
      const [rule] = update((r, at) => r.id === id && isActive(r, at), (r, at) => ({ ...r, revokedAt: at }), 'revoked')
      return rule ? { ok: true, rule } : { ok: false, error: 'inactive' }
    },
    revokeForAgent: (agentId) => update((r, at) => r.agentId === agentId && r.scope !== 'global' && isActive(r, at), (r, at) => ({ ...r, revokedAt: at }), 'revoked'),
    consumeOnce: (id) => update((r, at) => r.id === id && r.scope === 'once' && isActive(r, at), (r, at) => ({ ...r, usedAt: at }), 'used').length === 1,
    endTask: (taskId) => update((r, at) => r.taskId === taskId && (r.scope === 'task' || r.scope === 'once') && isActive(r, at), (r, at) => ({ ...r, endedAt: at }), 'ended'),
    sweep() {
      const at = now()
      const fresh = rules.filter((r) => ruleState(r, at) === 'expired' && !reportedExpired.has(r.id))
      for (const rule of fresh) reportedExpired.add(rule.id)
      for (const rule of fresh) onChange?.({ kind: 'expired', rule })
      return fresh
    },
    evaluate(query) {
      try { return evaluate(rules, query, now()) } catch { return { effect: 'deny', source: 'error', ruleId: null } }
    },
  }
}
