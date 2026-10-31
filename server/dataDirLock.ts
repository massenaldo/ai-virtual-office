import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

// One server per DATA_DIR. Two servers on the same folder would overwrite each other's token file, state file and audit log.
// The lock is a file naming the process; a lock whose process is gone (a crash) is replaced.

export const LOCK_FILE = 'server.lock'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // exists, but belongs to someone else
  }
}

export type DataDirLock = { release(): void }

export function acquireDataDirLock(dataDir: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, LOCK_FILE)
  const mine = `${process.pid}\n${randomBytes(8).toString('hex')}\n`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeSync(fd, mine) } finally { closeSync(fd) }
      let released = false
      return {
        release() {
          if (released) return
          released = true
          // Only remove it if it is still ours: another server may have taken over a lock it found stale.
          try { if (readFileSync(file, 'utf8') === mine) unlinkSync(file) } catch { /* already gone */ }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid = Number.NaN
      try { pid = Number(readFileSync(file, 'utf8').split('\n')[0]) } catch { /* unreadable: treat as stale */ }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error('Another server is using DATA_DIR.')
      try { unlinkSync(file) } catch { /* someone else removed it first */ }
    }
  }
  throw new Error('Another server is using DATA_DIR.')
}
