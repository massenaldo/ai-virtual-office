import { errorCode } from './errorCodes'
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './log'
import { scrub } from './redact'

// An append-only JSON Lines record of security-relevant actions. Records carry ids and reason codes, never request
// bodies, secrets or absolute workspace paths. One rotation keeps it from filling the disk, and a failed write never
// reaches request handling.

export const AUDIT_FILE = 'audit.log'
export const AUDIT_ROTATED_FILE = 'audit.log.1'
export const AUDIT_DETAIL_MAX = 512
export const AUDIT_FIELD_MAX = 64
export const REJECTED_PER_MINUTE = 30

export type AuditAction =
  | 'config.startup' | 'task.start' | 'task.cancel' | 'task.force_cancelled' | 'task.timeout'
  | 'approval.requested' | 'approval.decided' | 'approval.timeout'
  | 'tool.allowed' | 'tool.denied' | 'tool.asked' | 'tool.stale' | 'workspace.rejected' | 'request.rejected' | 'runtime.note'
  | 'permission.granted' | 'permission.denied' | 'permission.revoked' | 'permission.expired' | 'permission.used'

export type AuditActor = 'api' | 'system' | 'runtime'

export type AuditInput = { action: AuditAction; actor: AuditActor; requestId?: string; taskId?: string; agentId?: string; workspaceId?: string; tool?: string; decision?: string; reason?: string; /** Action digest (as the approval is bound to it), the SHA-256 of the canonical action, and the permission rule involved. */ digest?: string; actionHash?: string; ruleId?: string; detail?: string }

export type AuditRecord = { at: string; seq: number } & AuditInput

export type AuditStatus = { ok: boolean; error: string | null }

export type AuditLog = { write(entry: AuditInput): void; /** Writes the pending suppressed-count record, if any. Safe to call more than once. */ close(): void; readonly status: AuditStatus; readonly filePath: string }

/** hide: absolute paths that are replaced by '<workspace-root>' wherever they appear in `detail`. */
export type AuditOptions = { dataDir: string; maxBytes: number; now: () => string; log: Logger; hide?: string[] }

export const nullAudit: AuditLog = { write: () => {}, close: () => {}, status: { ok: true, error: null }, filePath: '' }

const codeOf = errorCode

export function openAuditLog({ dataDir, maxBytes, now, log, hide = [] }: AuditOptions): AuditLog {
  const filePath = join(dataDir, AUDIT_FILE)
  const rotatedPath = join(dataDir, AUDIT_ROTATED_FILE)
  let status: AuditStatus = { ok: true, error: null }
  let size = 0
  let seq = 0
  const logged = new Set<string>()
  // request.rejected rate limit: fixed 60 s windows.
  let windowStart = -1
  let inWindow = 0
  let suppressed = 0

  // The error is the code only: messages contain the absolute path.
  const fail = (error: unknown) => {
    const code = codeOf(error)
    status = { ok: false, error: code }
    if (!logged.has(code)) {
      logged.add(code)
      log.error(`Audit log unavailable: ${code}`)
    }
  }

  try {
    mkdirSync(dataDir, { recursive: true })
    let st
    try { st = statSync(filePath) } catch { st = null }
    if (st?.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' })
    if (st) {
      chmodSync(filePath, 0o600)
      size = st.size
    }
  } catch (error) {
    fail(error)
  }

  const hidePaths = (text: string) => hide.reduce((t, p) => t.split(p).join('<workspace-root>'), text)
  const field = (v: string | undefined) => (v === undefined ? undefined : scrub(v, AUDIT_FIELD_MAX))

  const emit = (e: AuditInput) => {
    const record: AuditRecord = {
      at: now(), seq: ++seq, action: e.action, actor: e.actor,
      requestId: field(e.requestId), taskId: field(e.taskId), agentId: field(e.agentId), workspaceId: field(e.workspaceId),
      tool: field(e.tool), decision: field(e.decision), reason: field(e.reason),
      digest: field(e.digest), actionHash: field(e.actionHash), ruleId: field(e.ruleId),
      detail: e.detail === undefined ? undefined : scrub(hidePaths(e.detail), AUDIT_DETAIL_MAX),
    }
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    try {
      let rotated = false
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(filePath, rotatedPath)
        size = 0
        rotated = true
      }
      appendFileSync(filePath, line, { mode: 0o600 })
      if (rotated) chmodSync(rotatedPath, 0o600)
      size += bytes
      status = { ok: true, error: null }
    } catch (error) {
      fail(error)
    }
  }

  const flushSuppressed = () => {
    if (suppressed === 0) return
    const count = suppressed
    suppressed = 0
    emit({ action: 'request.rejected', actor: 'system', reason: 'suppressed', detail: `${count} rejected requests were not logged` })
  }

  return {
    get status() { return status },
    filePath,
    write(entry) {
      // A new window starts with the first record of any kind, so the count of what was dropped comes right before it.
      const window = Math.floor(Date.parse(now()) / 60000)
      if (window !== windowStart) {
        windowStart = window
        inWindow = 0
        flushSuppressed()
      }
      if (entry.action === 'request.rejected' && entry.reason !== 'suppressed') {
        if (inWindow >= REJECTED_PER_MINUTE) { suppressed++; return }
        inWindow++
      }
      emit(entry)
    },
    close: flushSuppressed,
  }
}
