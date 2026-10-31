import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE, AUDIT_ROTATED_FILE, nullAudit, openAuditLog, type AuditOptions } from './audit'
import { recordingLogger } from './log'

const NOW = '2026-10-31T09:00:00.000Z'
let dir: string
let clock: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vo-audit-')); clock = NOW })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const open = (extra: Partial<AuditOptions> = {}) => {
  const log = recordingLogger()
  return { audit: openAuditLog({ dataDir: dir, maxBytes: 5242880, now: () => clock, log, ...extra }), log }
}
const lines = (name = AUDIT_FILE) => readFileSync(join(dir, name), 'utf8').trim().split('\n')
const mode = (name: string) => statSync(join(dir, name)).mode & 0o777

describe('openAuditLog', () => {
  it('appends JSON lines with seq, at and fixed key order', () => {
    const { audit } = open()
    audit.write({ action: 'task.start', actor: 'api', requestId: 'abc123abc123', taskId: 'task-1', agentId: 'agent-1', workspaceId: 'sandbox' })
    audit.write({ action: 'task.cancel', actor: 'system', taskId: 'task-1', agentId: 'agent-1' })
    const got = lines()
    expect(got[0]).toBe('{"at":"2026-10-31T09:00:00.000Z","seq":1,"action":"task.start","actor":"api","requestId":"abc123abc123","taskId":"task-1","agentId":"agent-1","workspaceId":"sandbox"}')
    expect(JSON.parse(got[1])).toMatchObject({ seq: 2, action: 'task.cancel' })
  })

  it('writes the permission fields in a fixed place and leaves old records unchanged', () => {
    const { audit } = open()
    audit.write({ action: 'permission.revoked', actor: 'api', agentId: 'agent-1', decision: 'revoke', digest: 'abc123abc123', actionHash: 'f'.repeat(64), ruleId: 'perm-1a2b3c4d', detail: 'by a person' })
    audit.write({ action: 'task.cancel', actor: 'system', taskId: 'task-1' })
    const got = lines()
    expect(got[0]).toBe('{"at":"2026-10-31T09:00:00.000Z","seq":1,"action":"permission.revoked","actor":"api","agentId":"agent-1","decision":"revoke","digest":"abc123abc123","actionHash":"' + 'f'.repeat(64) + '","ruleId":"perm-1a2b3c4d","detail":"by a person"}')
    expect(got[1]).toBe('{"at":"2026-10-31T09:00:00.000Z","seq":2,"action":"task.cancel","actor":"system","taskId":"task-1"}')
  })

  it('caps the permission fields and keeps a control character from forging a second line', () => {
    const { audit } = open()
    audit.write({ action: 'permission.used', actor: 'runtime', actionHash: 'f'.repeat(200), ruleId: 'perm\u0000-1\nx', digest: 'd'.repeat(200) })
    const record = JSON.parse(lines()[0])
    expect(record.actionHash).toHaveLength(64)
    expect(record.digest).toHaveLength(64)
    expect(lines()).toHaveLength(1)
    expect(record.ruleId).toBe('perm\u0000-1\nx')
  })

  it.each(['permission.granted', 'permission.denied', 'permission.revoked', 'permission.expired', 'permission.used'] as const)('accepts %s', (action) => {
    const { audit } = open()
    audit.write({ action, actor: 'api' })
    expect(JSON.parse(lines()[0]).action).toBe(action)
  })

  it('creates the file with mode 0o600 and tightens an existing one', () => {
    const { audit } = open()
    audit.write({ action: 'task.start', actor: 'api' })
    expect(mode(AUDIT_FILE)).toBe(0o600)
    rmSync(join(dir, AUDIT_FILE))
    writeFileSync(join(dir, AUDIT_FILE), '', { mode: 0o644 })
    chmodSync(join(dir, AUDIT_FILE), 0o644)
    open()
    expect(mode(AUDIT_FILE)).toBe(0o600)
  })

  it('rotates once at the size cap', () => {
    const { audit } = open({ maxBytes: 400 })
    for (let i = 0; i < 20; i++) audit.write({ action: 'task.start', actor: 'api', taskId: `task-${i}` })
    expect(readdirSync(dir).sort()).toEqual([AUDIT_FILE, AUDIT_ROTATED_FILE])
    expect(statSync(join(dir, AUDIT_FILE)).size).toBeLessThanOrEqual(400)
    const seqs = [...lines(AUDIT_ROTATED_FILE), ...lines()].map((l) => JSON.parse(l).seq as number)
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(true)
    expect(mode(AUDIT_ROTATED_FILE)).toBe(0o600)
  })

  it('scrubs secrets and hidden paths and truncates', () => {
    const { audit } = open({ hide: ['/srv/ws'] })
    audit.write({ action: 'runtime.note', actor: 'runtime', detail: 'path /srv/ws/a key sk-ant-api03-abcdefghijk' })
    audit.write({ action: 'task.start', actor: 'api', taskId: 'x'.repeat(100) })
    audit.write({ action: 'runtime.note', actor: 'runtime', detail: 'd'.repeat(2000) })
    const [a, b, c] = lines().map((l) => JSON.parse(l))
    expect(a.detail).toBe('path <workspace-root>/a key [REDACTED]')
    audit.write({ action: 'runtime.note', actor: 'runtime', detail: 'AKIAIOSFODNN7EXAMPLE and https://u:p@h.test' })
    expect(JSON.parse(lines().at(-1)!).detail).toBe('[REDACTED] and https://[REDACTED]@h.test')
    audit.write({ action: 'runtime.note', actor: 'runtime', detail: `redis://:p@ss@host and ${['AIza', 'SyA-1234567890abcdefghijklmnopqrstu'].join('')}` })
    expect(JSON.parse(lines().at(-1)!).detail).toBe('redis://[REDACTED]@host and [REDACTED]')
    expect(b.taskId).toHaveLength(64)
    expect(b.taskId.endsWith('…')).toBe(true)
    expect(c.detail).toHaveLength(512)
  })

  it('never throws when writing fails and logs once', () => {
    mkdirSync(join(dir, AUDIT_FILE))
    const { audit, log } = open()
    expect(audit.status).toEqual({ ok: false, error: 'EISDIR' })
    expect(() => { audit.write({ action: 'task.start', actor: 'api' }); audit.write({ action: 'task.start', actor: 'api' }) }).not.toThrow()
    expect(log.lines.filter((l) => l.startsWith('error')).length).toBe(1)
    expect(log.lines.join('\n')).not.toContain(dir)
  })

  it('recovers its status after a later successful write', () => {
    const { audit } = open()
    rmSync(join(dir, AUDIT_FILE), { force: true })
    mkdirSync(join(dir, AUDIT_FILE))
    audit.write({ action: 'task.start', actor: 'api' })
    expect(audit.status.ok).toBe(false)
    rmSync(join(dir, AUDIT_FILE), { recursive: true })
    audit.write({ action: 'task.start', actor: 'api' })
    expect(audit.status).toEqual({ ok: true, error: null })
  })

  it('limits request.rejected records per minute', () => {
    const { audit } = open()
    for (let i = 0; i < 35; i++) audit.write({ action: 'request.rejected', actor: 'api', reason: 'origin' })
    expect(lines()).toHaveLength(30)
    audit.write({ action: 'task.start', actor: 'api' })
    expect(lines()).toHaveLength(31)
    clock = '2026-10-31T09:01:01.000Z'
    audit.write({ action: 'request.rejected', actor: 'api', reason: 'host' })
    const all = lines().map((l) => JSON.parse(l))
    expect(all.at(-2)).toMatchObject({ action: 'request.rejected', actor: 'system', reason: 'suppressed', detail: '5 rejected requests were not logged' })
    expect(all.at(-1)).toMatchObject({ action: 'request.rejected', reason: 'host' })
  })
})

describe('the suppressed-count record', () => {
  it('is written before the first record of any kind in the next window', () => {
    const { audit } = open()
    for (let i = 0; i < 36; i++) audit.write({ action: 'request.rejected', actor: 'api', reason: 'origin' })
    clock = '2026-10-31T09:01:30.000Z'
    audit.write({ action: 'task.start', actor: 'api', taskId: 't1' })
    const all = lines().map((l) => JSON.parse(l))
    expect(all.at(-2)).toMatchObject({ action: 'request.rejected', actor: 'system', reason: 'suppressed', detail: '6 rejected requests were not logged' })
    expect(all.at(-1)).toMatchObject({ action: 'task.start', taskId: 't1' })
    audit.write({ action: 'task.start', actor: 'api', taskId: 't2' })
    expect(lines().filter((l) => l.includes('suppressed'))).toHaveLength(1)
  })

  it('is written when the log is closed, so a count is never lost', () => {
    const { audit } = open()
    for (let i = 0; i < 33; i++) audit.write({ action: 'request.rejected', actor: 'api', reason: 'origin' })
    audit.close()
    expect(JSON.parse(lines().at(-1)!)).toMatchObject({ reason: 'suppressed', detail: '3 rejected requests were not logged' })
    audit.close()
    expect(lines().filter((l) => l.includes('suppressed'))).toHaveLength(1)
  })

  it('writes nothing extra when nothing was suppressed', () => {
    const { audit } = open()
    audit.write({ action: 'task.start', actor: 'api' })
    audit.close()
    expect(lines()).toHaveLength(1)
  })
})

describe('nullAudit', () => {
  it('does nothing', () => {
    nullAudit.write({ action: 'task.start', actor: 'api' })
    nullAudit.close()
    expect(nullAudit.status).toEqual({ ok: true, error: null })
    expect(nullAudit.filePath).toBe('')
  })
})
