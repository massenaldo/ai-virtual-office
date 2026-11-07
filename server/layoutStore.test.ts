import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../src/layout/defaultLayout'
import { updateFurniture } from '../src/layout/operations'
import { serializeLayout } from '../src/layout/storage'
import { LAYOUT_BACKUP_FILE, LAYOUT_FILE, openLayoutStore } from './layoutStore'
import { recordingLogger, silentLogger } from './log'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vo-layout-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const file = () => join(dir, LAYOUT_FILE)
const open = (extra: Partial<Parameters<typeof openLayoutStore>[0]> = {}) => openLayoutStore({ dataDir: dir, log: silentLogger, ...extra })
const edited = () => updateFurniture(createDefaultLayout(), 'plant-01', { x: 5 })
const files = () => readdirSync(dir).sort()

describe('openLayoutStore', () => {
  it('a missing file gives no layout, no problem, and writes nothing', () => {
    const store = open()
    expect(store.layout).toBeNull()
    expect(store.problem).toBeNull()
    expect(files()).toEqual([])
  })

  it('saves, keeps the layout in memory and writes the normalised json', () => {
    const store = open()
    const r = store.save(edited())
    expect(r).toEqual({ ok: true, json: serializeLayout(edited()) })
    expect(store.layout).toEqual(edited())
    expect(readFileSync(file(), 'utf8')).toBe(serializeLayout(edited()))
  })

  it('a reopened store reads what was saved', () => {
    open().save(edited())
    const again = open()
    expect(again.layout).toEqual(edited())
    expect(again.problem).toBeNull()
  })

  it('a damaged file is backed up, reported as corrupt, and left in place until a save', () => {
    writeFileSync(file(), '{nope')
    const log = recordingLogger()
    const store = open({ log })
    expect(store).toMatchObject({ layout: null, problem: 'corrupt' })
    expect(readFileSync(join(dir, LAYOUT_BACKUP_FILE), 'utf8')).toBe('{nope')
    expect(readFileSync(file(), 'utf8')).toBe('{nope')
    expect(log.lines.some((l) => l.startsWith('warn'))).toBe(true)
  })

  it('a structurally invalid layout is corrupt', () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 1, office: {}, rooms: [], furniture: [] }))
    expect(open().problem).toBe('corrupt')
  })

  it('a newer schema is unsupported-version and backed up', () => {
    const text = JSON.stringify({ schemaVersion: 99, whatever: true })
    writeFileSync(file(), text)
    const store = open()
    expect(store).toMatchObject({ layout: null, problem: 'unsupported-version' })
    expect(readFileSync(join(dir, LAYOUT_BACKUP_FILE), 'utf8')).toBe(text)
  })

  it('a successful save clears the problem', () => {
    writeFileSync(file(), '{nope')
    const store = open()
    expect(store.save(edited()).ok).toBe(true)
    expect(store.problem).toBeNull()
    expect(store.layout).toEqual(edited())
    expect(open().problem).toBeNull()
  })

  it('keeps an existing different backup and uses the next numbered one', () => {
    writeFileSync(join(dir, LAYOUT_BACKUP_FILE), 'older')
    writeFileSync(file(), '{nope')
    open()
    expect(readFileSync(join(dir, LAYOUT_BACKUP_FILE), 'utf8')).toBe('older')
    expect(readFileSync(join(dir, 'layout.backup.1.json'), 'utf8')).toBe('{nope')
    writeFileSync(file(), '{other')
    open()
    expect(readFileSync(join(dir, 'layout.backup.2.json'), 'utf8')).toBe('{other')
  })

  it('restarts do not pile up copies of the same damaged file', () => {
    writeFileSync(file(), '{nope')
    open(); open(); open()
    expect(files()).toEqual([LAYOUT_BACKUP_FILE, LAYOUT_FILE])
  })

  it('a restart finds the same bytes in a later numbered backup and adds nothing', () => {
    writeFileSync(join(dir, LAYOUT_BACKUP_FILE), 'older')
    writeFileSync(file(), '{nope')
    open(); open()
    expect(files()).toEqual(['layout.backup.1.json', LAYOUT_BACKUP_FILE, LAYOUT_FILE])
  })

  it('refuses saves rather than lose data when no backup slot is free', () => {
    for (let i = 0; i <= 100; i++) writeFileSync(join(dir, i === 0 ? LAYOUT_BACKUP_FILE : `layout.backup.${i}.json`), `old${i}`)
    writeFileSync(file(), '{nope')
    const log = recordingLogger()
    const store = open({ log })
    expect(store.problem).toBe('corrupt')
    expect(store.save(edited()).ok).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{nope')
    expect(log.lines.some((l) => l.startsWith('warn'))).toBe(true)
  })

  it('a failed write keeps the earlier layout and problem, and logs each message once', () => {
    writeFileSync(file(), '{nope')
    const log = recordingLogger()
    let fail = false
    const store = open({ log, writeFile: (p, t) => { if (fail && p === file()) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' }); writeFileSync(p, t) } })
    fail = true
    expect(store.save(edited())).toEqual({ ok: false, error: 'EACCES' })
    expect(store.save(edited())).toEqual({ ok: false, error: 'EACCES' })
    expect(store).toMatchObject({ layout: null, problem: 'corrupt' })
    expect(log.lines.filter((l) => l.startsWith('error'))).toHaveLength(1)
    expect(readFileSync(file(), 'utf8')).toBe('{nope')
  })

  it('a failed write after a good save keeps the good layout', () => {
    let fail = false
    const store = open({ writeFile: (p, t) => { if (fail) throw new Error('boom'); writeFileSync(p, t) } })
    store.save(createDefaultLayout())
    fail = true
    expect(store.save(edited())).toEqual({ ok: false, error: 'write_failed' })
    expect(store.layout).toEqual(createDefaultLayout())
  })

  it('an unreadable file other than missing throws', () => {
    mkdirSync(file())
    expect(() => open()).toThrow(/EISDIR/)
  })
})
