import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordingLogger, silentLogger } from '../log'
import { parsePermissions } from './storage'
import { openPermissionStore, PERMISSIONS_BACKUP_FILE, PERMISSIONS_FILE, type PermissionChange, type PermissionStoreOptions } from './store'
import type { GrantInput, PermissionQuery } from './types'

let dir: string
let clock: number
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vo-perm-')); clock = Date.parse('2026-11-01T10:00:00.000Z') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const now = () => new Date(clock).toISOString()
const file = () => join(dir, PERMISSIONS_FILE)
const open = (extra: Partial<PermissionStoreOptions> = {}) => openPermissionStore({ dataDir: dir, now, log: silentLogger, ...extra })
const D = (c: string) => c.repeat(64)
const q = (o: Partial<PermissionQuery> = {}): PermissionQuery => ({ agentId: 'a1', taskId: 't1', tool: 'Write', digest: D('a'), paths: ['src/x.ts'], ...o })
const agentWrite: GrantInput = { scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a1' }
const once = (c: string): GrantInput => ({ scope: 'once', effect: 'allow', tool: 'Write', agentId: 'a1', taskId: 't1', digest: D(c) })
const granted = (s: ReturnType<typeof open>, i: GrantInput) => { const r = s.grant(i); if (!r.ok) throw new Error(r.error); return r.rule }

describe('opening', () => {
  it('seeds the defaults on first start and writes a parseable file', () => {
    const s = open()
    expect(s.load).toEqual({ seeded: true, problem: null, preserved: null })
    expect(s.rules).toHaveLength(8)
    expect(parsePermissions(JSON.parse(readFileSync(file(), 'utf8')))).toEqual(s.rules)
    expect(s.filePath).toBe(file())
  })
  it('keeps grants across a restart', () => {
    const rule = granted(open(), agentWrite)
    const again = open()
    expect(again.load.seeded).toBe(false)
    expect(again.rules.find((r) => r.id === rule.id)).toEqual(rule)
  })
})

describe('grant and revoke', () => {
  it('refuses an invalid grant and writes nothing', () => {
    const s = open()
    const before = readFileSync(file(), 'utf8')
    expect(s.grant({ ...agentWrite, agentId: null })).toEqual({ ok: false, error: 'missing_agent' })
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })
  it('stops at the active-rule limit, not counting defaults', () => {
    const s = open({ limits: { maxActive: 2, maxHistory: 10 } })
    granted(s, agentWrite); granted(s, { ...agentWrite, tool: 'Edit' })
    expect(s.grant({ ...agentWrite, tool: 'Glob' })).toEqual({ ok: false, error: 'limit' })
  })
  it('makes a revoke count on the very next evaluate', () => {
    const s = open()
    const rule = granted(s, agentWrite)
    expect(s.evaluate(q())).toMatchObject({ effect: 'allow', source: 'agent' })
    expect(s.revoke(rule.id)).toMatchObject({ ok: true, rule: { revokedAt: now() } })
    expect(s.evaluate(q())).toMatchObject({ effect: 'ask', source: 'global' })
    expect(s.revoke(rule.id)).toEqual({ ok: false, error: 'inactive' })
    expect(s.revoke('nope')).toEqual({ ok: false, error: 'not_found' })
  })
  it('revokes agent, task and once rules for one agent only', () => {
    const s = open()
    const mine = [granted(s, agentWrite), granted(s, { scope: 'task', effect: 'allow', tool: 'Edit', agentId: 'a1', taskId: 't1' }), granted(s, once('b'))]
    const other = granted(s, { ...agentWrite, agentId: 'a2' })
    const global = granted(s, { scope: 'global', effect: 'allow', tool: 'Glob' })
    expect(s.revokeForAgent('a1').map((r) => r.id).sort()).toEqual(mine.map((r) => r.id).sort())
    const active = (id: string) => s.rules.find((r) => r.id === id)!.revokedAt === null
    expect(active(other.id) && active(global.id)).toBe(true)
  })
})

describe('consumeOnce', () => {
  it('is true exactly once, even for two calls in one tick', () => {
    const s = open()
    const rule = granted(s, once('b'))
    expect([s.consumeOnce(rule.id), s.consumeOnce(rule.id)]).toEqual([true, false])
    expect(s.evaluate(q({ digest: D('b') })).source).toBe('global')
  })
  it('is false after a revoke, for a non-once rule and for an unknown id', () => {
    const s = open()
    const rule = granted(s, once('b'))
    s.revoke(rule.id)
    expect(s.consumeOnce(rule.id)).toBe(false)
    expect(s.consumeOnce(granted(s, agentWrite).id)).toBe(false)
    expect(s.consumeOnce('nope')).toBe(false)
  })
})

describe('endTask and sweep', () => {
  it('ends task and once rules of that task only', () => {
    const s = open()
    const task = granted(s, { scope: 'task', effect: 'allow', tool: 'Edit', agentId: 'a1', taskId: 't1' })
    const o = granted(s, once('b'))
    const elsewhere = granted(s, { scope: 'task', effect: 'allow', tool: 'Edit', agentId: 'a1', taskId: 't2' })
    const agent = granted(s, agentWrite)
    expect(s.endTask('t1').map((r) => r.id).sort()).toEqual([task.id, o.id].sort())
    expect(s.evaluate(q({ tool: 'Edit' })).source).toBe('global')
    expect(s.rules.find((r) => r.id === elsewhere.id)!.endedAt).toBeNull()
    expect(s.rules.find((r) => r.id === agent.id)!.endedAt).toBeNull()
  })
  it('reports an expired rule once', () => {
    const s = open()
    const rule = granted(s, { ...agentWrite, expiresAt: '2026-11-01T10:05:00.000Z' })
    expect(s.sweep()).toEqual([])
    clock += 5 * 60_000
    expect(s.evaluate(q()).source).toBe('global')
    expect(s.sweep().map((r) => r.id)).toEqual([rule.id])
    expect(s.sweep()).toEqual([])
  })
  it('tells onChange about every kind of change', () => {
    const seen: PermissionChange['kind'][] = []
    const s = open({ onChange: (c) => seen.push(c.kind) })
    const a = granted(s, agentWrite)
    s.revoke(a.id)
    s.consumeOnce(granted(s, once('b')).id)
    granted(s, { scope: 'task', effect: 'allow', tool: 'Edit', agentId: 'a1', taskId: 't9' }); s.endTask('t9')
    granted(s, { ...agentWrite, tool: 'Glob', expiresAt: '2026-11-01T10:01:00.000Z' }); clock += 120_000; s.sweep()
    expect(seen).toEqual(['granted', 'revoked', 'granted', 'used', 'granted', 'ended', 'granted', 'expired'])
  })
})

describe('a damaged file', () => {
  const onlyDefaults = (s: ReturnType<typeof open>) => expect(s.rules.map((r) => r.id)).toEqual(['default-read', 'default-glob', 'default-grep', 'default-write', 'default-edit', 'default-bash', 'default-webfetch', 'default-websearch'])

  it('loads defaults only, backs the file up and never allows more', () => {
    writeFileSync(file(), '{ not json')
    const log = recordingLogger()
    const s = open({ log })
    expect(s.load).toMatchObject({ seeded: false, problem: 'corrupt', preserved: 'backup-created' })
    expect(readFileSync(join(dir, PERMISSIONS_BACKUP_FILE), 'utf8')).toBe('{ not json')
    expect(readFileSync(file(), 'utf8')).toBe('{ not json')
    onlyDefaults(s)
    expect(s.evaluate(q())).toMatchObject({ effect: 'ask' })
    expect(log.lines.some((l) => l.startsWith('warn'))).toBe(true)
  })
  it('does not keep an allow rule from a file that has a bad field elsewhere', () => {
    const bad = { id: 'x', scope: 'global', effect: 'allow', tool: 'Bash', agentId: null, taskId: null, pathPattern: null, digest: null, createdAt: now(), createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null }
    writeFileSync(file(), JSON.stringify({ schemaVersion: 1, rules: [bad, { ...bad, id: 'y', scope: 'galaxy' }] }))
    const s = open()
    onlyDefaults(s)
    expect(s.evaluate(q({ tool: 'Bash' })).effect).toBe('deny')
  })
  it('reports a newer schema version as unsupported', () => {
    writeFileSync(file(), JSON.stringify({ schemaVersion: 99, rules: [] }))
    expect(open().load.problem).toBe('unsupported-version')
  })
  it('keeps an earlier backup instead of overwriting it', () => {
    writeFileSync(join(dir, PERMISSIONS_BACKUP_FILE), 'older')
    writeFileSync(file(), 'garbage')
    expect(open().load.preserved).toBe('backup-exists')
    expect(readFileSync(join(dir, PERMISSIONS_BACKUP_FILE), 'utf8')).toBe('older')
  })
})

describe('failure handling', () => {
  it('keeps a revoke in force when saving fails', () => {
    let failing = false
    const s = open({ writeFile: (p, t) => { if (failing) throw Object.assign(new Error('x'), { code: 'EACCES' }); writeFileSync(p, t) } })
    const rule = granted(s, agentWrite)
    failing = true
    expect(s.revoke(rule.id).ok).toBe(true)
    expect(s.saveError).toBe('EACCES')
    expect(s.evaluate(q()).source).toBe('global')
  })
  it('prunes old inactive rules but keeps defaults and active ones', () => {
    const s = open({ limits: { maxActive: 50, maxHistory: 3 } })
    const keep = granted(s, agentWrite)
    const ids = 'bcdef'.split('').map((c) => { const r = granted(s, once(c)); s.consumeOnce(r.id); return r.id })
    const ids2 = s.rules.map((r) => r.id)
    expect(ids2.filter((id) => ids.includes(id))).toEqual(ids.slice(2))
    expect(ids2).toContain(keep.id)
    expect(ids2.filter((id) => id.startsWith('default-'))).toHaveLength(8)
  })
  it('denies instead of throwing when a rule cannot be read', () => {
    const s = open()
    Object.defineProperty(s.rules.find((r) => r.id === 'default-write')!, 'pathPattern', { get() { throw new Error('boom') } })
    expect(s.evaluate(q())).toEqual({ effect: 'deny', source: 'error', ruleId: null })
  })
})
