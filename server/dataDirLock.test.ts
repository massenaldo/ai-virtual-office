import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataDirLock, LOCK_FILE } from './dataDirLock'
import { tempDataDir } from './test/helpers'

const dirs: string[] = []
const fresh = () => { const d = tempDataDir(); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('acquireDataDirLock', () => {
  it('creates a private lock file naming this process', () => {
    const dir = fresh()
    const lock = acquireDataDirLock(dir)
    expect(statSync(join(dir, LOCK_FILE)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0]).toBe(String(process.pid))
    lock.release()
  })

  it('refuses a second holder while the first process is alive', () => {
    const dir = fresh()
    const first = acquireDataDirLock(dir)
    expect(() => acquireDataDirLock(dir)).toThrow('Another server is using DATA_DIR.')
    first.release()
  })

  it('replaces a lock whose process is gone', () => {
    const dir = fresh()
    writeFileSync(join(dir, LOCK_FILE), '99999999\nstale\n')
    const lock = acquireDataDirLock(dir)
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8').split('\n')[0]).toBe(String(process.pid))
    lock.release()
  })

  it('replaces an unreadable lock', () => {
    const dir = fresh()
    writeFileSync(join(dir, LOCK_FILE), 'garbage')
    acquireDataDirLock(dir).release()
  })

  it('removes its lock on release, so a new holder can start', () => {
    const dir = fresh()
    acquireDataDirLock(dir).release()
    expect(() => statSync(join(dir, LOCK_FILE))).toThrow()
    acquireDataDirLock(dir).release()
  })

  it('does not remove a lock somebody else took over, and release twice is harmless', () => {
    const dir = fresh()
    const lock = acquireDataDirLock(dir)
    writeFileSync(join(dir, LOCK_FILE), '1\nsomeone-else\n')
    lock.release()
    lock.release()
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toContain('someone-else')
  })
})
