import { errorCode, type ErrorCode } from './errorCodes'
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createDemoWorkforce } from '../src/workforce/demo'
import { emptyWorkforce, recoverInterruptedTasks } from '../src/workforce/operations'
import { parseWorkforce, serializeWorkforce } from '../src/workforce/storage'
import { WORKFORCE_SCHEMA_VERSION, type WorkforceState } from '../src/workforce/types'
import type { Logger } from './log'

export const WORKFORCE_FILE = 'workforce.json'
export const WORKFORCE_BACKUP_FILE = 'workforce.backup.json'
export const SERVER_RESTART_MESSAGE = 'Interrupted by a server restart'

export type StoreLoad = { seeded: boolean; recovered: boolean; problem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null }

export type StoreOptions = {
  dataDir: string
  now: () => string
  log: Logger
  onCommit?: (before: WorkforceState, after: WorkforceState) => void
  /** Test seam; defaults to writeFileAtomic. */
  writeFile?: (path: string, text: string) => void
}

export type WorkforceStore = { readonly state: WorkforceState; readonly load: StoreLoad; readonly saveError: ErrorCode | null; readonly filePath: string; commit(next: WorkforceState): boolean }

/** Write to a private temp file, flush it, then rename over the target: a crash leaves the old file or the new one, never half of one. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* nothing to clean up */ }
    throw error
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The only holder of workforce state. Every change is read-op-commit with no await in between (Node runs one thread),
 * and commit() saves synchronously, so the file always matches the state in memory unless a write failed.
 */
export function openWorkforceStore({ dataDir, now, log, onCommit, writeFile = writeFileAtomic }: StoreOptions): WorkforceStore {
  mkdirSync(dataDir, { recursive: true })
  const filePath = join(dataDir, WORKFORCE_FILE)
  const backupPath = join(dataDir, WORKFORCE_BACKUP_FILE)
  let saveError: ErrorCode | null = null
  const logged = new Set<string>()

  const save = (state: WorkforceState) => {
    try {
      writeFile(filePath, serializeWorkforce(state))
      saveError = null
    } catch (error) {
      // Only the code is kept (it reaches /api/health and /api/state); the full message, with the path, goes to the server log only.
      saveError = errorCode(error)
      const message = error instanceof Error ? error.message : 'Saving failed.'
      if (!logged.has(message)) {
        logged.add(message)
        log.error(`Couldn't save workforce data to ${filePath}: ${message}`)
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

  let state: WorkforceState
  const load: StoreLoad = { seeded: false, recovered: false, problem: null, preserved: null }

  if (text === null) {
    // The file doubles as the "first start is done" marker, so deleting every agent never brings the demo back.
    state = createDemoWorkforce(now())
    load.seeded = true
    save(state)
  } else {
    let parsed: WorkforceState | null = null
    let raw: unknown
    try {
      raw = JSON.parse(text)
      parsed = parseWorkforce(raw)
    } catch {
      parsed = null
    }
    if (parsed) {
      state = recoverInterruptedTasks(parsed, now(), SERVER_RESTART_MESSAGE)
      if (state !== parsed) {
        load.recovered = true
        save(state)
      }
    } else {
      state = emptyWorkforce()
      load.problem = isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > WORKFORCE_SCHEMA_VERSION ? 'unsupported-version' : 'corrupt'
      let existing: string | null = null
      try { existing = readFileSync(backupPath, 'utf8') } catch { existing = null }
      if (existing === null) {
        copyFileSync(filePath, backupPath)
        load.preserved = 'backup-created'
      } else {
        load.preserved = existing === text ? 'backup-created' : 'backup-exists'
      }
      const lead = `Workforce data in ${filePath} couldn't be read (${load.problem}).`
      log.warn(load.preserved === 'backup-created'
        ? `${lead} It was backed up to ${backupPath}. Starting with no agents.`
        : `${lead} An earlier backup already exists at ${backupPath}, so this file was not backed up and the next change replaces it. Starting with no agents.`)
    }
  }

  return {
    get state() { return state },
    get saveError() { return saveError },
    load,
    filePath,
    commit(next) {
      if (next === state) return false
      const before = state
      state = next
      save(next)
      onCommit?.(before, next)
      return true
    },
  }
}
