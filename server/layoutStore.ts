import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAYOUT_SCHEMA_VERSION, type OfficeLayout } from '../src/layout/types'
import { migrateLayout, parseLayout, serializeLayout } from '../src/layout/storage'
import { errorCode, type ErrorCode } from './errorCodes'
import type { Logger } from './log'
import { writeFileAtomic } from './store'

export const LAYOUT_FILE = 'layout.json'
export const LAYOUT_BACKUP_FILE = 'layout.backup.json'
/** How many backup names are tried before saves are refused rather than overwrite a file that may hold someone's only copy. */
const BACKUP_SLOTS = 100

export type LayoutProblem = 'corrupt' | 'unsupported-version'
export type LayoutStoreOptions = { dataDir: string; log: Logger; /** Test seam; defaults to writeFileAtomic. */ writeFile?: (path: string, text: string) => void }
export type LayoutStore = {
  readonly layout: OfficeLayout | null
  readonly problem: LayoutProblem | null
  readonly filePath: string
  save(layout: OfficeLayout): { ok: true; json: string } | { ok: false; error: ErrorCode }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const backupName = (n: number) => (n === 0 ? LAYOUT_BACKUP_FILE : `layout.backup.${n}.json`)

/** The only holder of the office layout. Loaded once; a missing file stays missing until the first save. */
export function openLayoutStore({ dataDir, log, writeFile = writeFileAtomic }: LayoutStoreOptions): LayoutStore {
  mkdirSync(dataDir, { recursive: true })
  const filePath = join(dataDir, LAYOUT_FILE)
  let layout: OfficeLayout | null = null
  let problem: LayoutProblem | null = null
  /** Set when a damaged file could not be preserved: saving would destroy it. */
  let blocked = false
  const logged = new Set<string>()

  let text: string | null = null
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw new Error(`Couldn't read ${filePath}: ${code ?? (error as Error).message}`)
  }

  if (text !== null) {
    let raw: unknown
    let parsed: OfficeLayout | null = null
    try {
      raw = JSON.parse(text)
      parsed = parseLayout(migrateLayout(raw))
    } catch {
      parsed = null
    }
    if (parsed) {
      layout = parsed
    } else {
      problem = isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > LAYOUT_SCHEMA_VERSION ? 'unsupported-version' : 'corrupt'
      const lead = `Layout data in ${filePath} couldn't be read (${problem}).`
      blocked = true
      for (let n = 0; n < BACKUP_SLOTS; n++) {
        const path = join(dataDir, backupName(n))
        let existing: string | null = null
        try {
          existing = readFileSync(path, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { log.warn(`${lead} Couldn't read the backup ${path}, so saving the layout is off.`); break }
        }
        if (existing === text) {
          blocked = false
          log.warn(`${lead} A backup with the same content exists at ${path}. The default layout is shown and the next save replaces the file.`)
          break
        }
        if (existing === null) {
          try {
            writeFile(path, text)
            blocked = false
            log.warn(`${lead} It was backed up to ${path}. The default layout is shown and the next save replaces the file.`)
          } catch (error) {
            log.warn(`${lead} Couldn't write the backup ${path} (${errorCode(error)}), so saving the layout is off.`)
          }
          break
        }
        if (n === BACKUP_SLOTS - 1) log.warn(`${lead} ${BACKUP_SLOTS} backups already exist in ${dataDir}, so saving the layout is off until some are removed.`)
      }
    }
  }

  return {
    get layout() { return layout },
    get problem() { return problem },
    filePath,
    save(next) {
      if (blocked) return { ok: false, error: 'write_failed' }
      const json = serializeLayout(next)
      try {
        writeFile(filePath, json)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Saving failed.'
        if (!logged.has(message)) {
          logged.add(message)
          log.error(`Couldn't save the layout to ${filePath}: ${message}`)
        }
        return { ok: false, error: errorCode(error) }
      }
      layout = next
      problem = null
      return { ok: true, json }
    },
  }
}
