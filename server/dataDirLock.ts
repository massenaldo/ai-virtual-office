import { randomBytes } from 'node:crypto'
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

// One server per DATA_DIR. Two servers on the same folder would overwrite each other's token file, state file and audit log.
// The lock is a file naming the process. It is created complete and atomically (written to a private temporary name, then
// linked into place), so nobody ever reads a half-written lock. A lock whose process is gone (a crash) is replaced, and
// only one process at a time may do the replacing; anyone else who sees that happening treats the folder as in use.

export const LOCK_FILE = 'server.lock'
const BUSY = 'Another server is using DATA_DIR.'
/** A lock that cannot be read as a process id is treated as held unless it is this old (a crashed write from an older version). */
const UNREADABLE_STALE_MS = 5000

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' // exists, but belongs to someone else
  }
}

export type DataDirLock = { release(): void }

/** True if the lock file's holder is gone (or it is an old unreadable file), so it may be replaced. */
function isStale(file: string): { stale: boolean; content: string | null } {
  let content: string | null = null
  try { content = readFileSync(file, 'utf8') } catch { return { stale: true, content: null } } // vanished: nothing holds it
  const pid = Number(content.split('\n')[0])
  if (Number.isInteger(pid) && pid > 0) return { stale: !alive(pid), content }
  try { return { stale: Date.now() - statSync(file).mtimeMs > UNREADABLE_STALE_MS, content } } catch { return { stale: true, content } }
}

export function acquireDataDirLock(dataDir: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = join(dataDir, LOCK_FILE)
  const takeover = `${file}.takeover`
  const nonce = randomBytes(8).toString('hex')
  const mine = `${process.pid}\n${nonce}\n`
  const tmp = `${file}.${process.pid}.${nonce}.tmp`

  const fd = openSync(tmp, 'wx', 0o600)
  try { writeSync(fd, mine) } finally { closeSync(fd) }

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file) // atomic, and fails if the lock exists
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
      }
      const seen = isStale(file)
      if (!seen.stale) throw new Error(BUSY)
      // Replace a stale lock under a mutex (mkdir is atomic). If someone else holds it, they are replacing it: busy.
      try { mkdirSync(takeover) } catch { throw new Error(BUSY) }
      try {
        // Re-read inside the mutex: only remove the very lock that was judged stale.
        if (seen.content === null || isStale(file).content === seen.content) { try { unlinkSync(file) } catch { /* gone */ } }
      } finally {
        try { rmdirSync(takeover) } catch { /* already removed */ }
      }
    }
    throw new Error(BUSY)
  } finally {
    try { unlinkSync(tmp) } catch { /* the temporary name is not needed once linked or refused */ }
  }
}
