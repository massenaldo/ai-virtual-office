import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE } from '../audit'
import { api, audit, pendingApproval, session, srv, start, stop, tasks, until, workspaceRoot, type Harness } from '../test/claudeHarness'

// The write tools of the claude runtime in the whole server: a real MCP client calls vo_write and vo_edit, the calls go through the
// real gate, permission rules, approval flow and file operations, and files are really created in a real workspace. What matters
// here is what must NOT happen: nothing is written without an approval of exactly that content, and an approval does not survive a
// change to the content, the target or the path.

const CANARY = 'WRITE-CANARY-7f3a9c'
let outside: string
let h: Harness
afterEach(async () => { await stop(); if (outside) rmSync(outside, { recursive: true, force: true }) })

async function setup(env: Record<string, string> = {}) {
  outside = mkdtempSync(join(tmpdir(), 'vo-outside-'))
  writeFileSync(join(outside, 'victim.txt'), 'OUTSIDE ORIGINAL\n')
  h = await start(env, (root) => {
    writeFileSync(join(root, 'notes.txt'), 'hello world\nsecond line\nhello again\n')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'plan.md'), '# plan\n')
    writeFileSync(join(root, '.env'), 'API_TOKEN=should-never-be-read\n')
    mkdirSync(join(root, '.git'))
    symlinkSync(join(outside, 'victim.txt'), join(root, 'link.txt'))
  })
  return h
}
const file = (rel: string) => join(workspaceRoot(), 'sandbox', rel)
const read = (rel: string) => readFileSync(file(rel), 'utf8')
const decide = (id: string, p: { id: string; digest: string | null }, decision = 'allow_once') => api('POST', `/api/tasks/${id}/approval`, { approvalId: p.id, decision, digest: p.digest })
const status = async (id: string) => (await tasks()).find((t) => t.id === id)!.status

describe('a write waits for a person and is made exactly as approved', () => {
  it('asks by default, shows the whole content, writes nothing until approved, then writes exactly that', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'new.txt', content: `${CANARY}\nsecond line\n` })
    const p = await pendingApproval(id)
    expect(p).toMatchObject({ tool: 'Write', digest: expect.stringMatching(/^[0-9a-f]{64}$/), review: { kind: 'write', path: 'new.txt', content: `${CANARY}\nsecond line\n`, workspaceId: 'sandbox' } })
    expect(existsSync(file('new.txt'))).toBe(false)
    expect((await decide(id, p)).status).toBe(200)
    const r = await pending
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toBe(`Wrote ${Buffer.byteLength(`${CANARY}\nsecond line\n`)} bytes to new.txt.`)
    expect(read('new.txt')).toBe(`${CANARY}\nsecond line\n`)
    expect(statSync(file('new.txt')).mode & 0o777).toBe(0o600)
    await until(async () => (await status(id)) === 'running')
  })

  it('writes nothing when the person rejects, and the model is told', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'new.txt', content: 'no' })
    const p = await pendingApproval(id)
    await decide(id, p, 'reject')
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'The action was not approved.' }] })
    expect(existsSync(file('new.txt'))).toBe(false)
    await until(async () => (await status(id)) === 'running')
  })

  it('refuses an approval that carries another action\'s digest, and the write stays pending and unwritten', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'new.txt', content: 'a' })
    const p = await pendingApproval(id)
    expect((await decide(id, { id: p.id, digest: '0'.repeat(64) })).status).toBe(409)
    expect((await api('POST', `/api/tasks/${id}/approval`, { approvalId: p.id, decision: 'allow_once' })).status).toBe(409)
    expect(await status(id)).toBe('waiting_for_approval')
    expect(existsSync(file('new.txt'))).toBe(false)
    await api('POST', `/api/tasks/${id}/cancel`)
    expect(await pending).toMatchObject({ isError: true })
  })

  it('does not carry an approval over to different content for the same path, or to the same content a second time', async () => {
    await setup()
    const { id, call } = await session(h)
    const first = call('vo_write', { file_path: 'new.txt', content: 'approved content\n' })
    await decide(id, await pendingApproval(id))
    expect((await first).isError).toBeUndefined()
    // Different content for the same path asks again, and the file is untouched until it is approved.
    const changed = call('vo_write', { file_path: 'new.txt', content: 'changed content\n' })
    const p2 = await pendingApproval(id)
    expect(p2.review!.content).toBe('changed content\n')
    expect(read('new.txt')).toBe('approved content\n')
    await decide(id, p2, 'reject')
    expect((await changed).isError).toBe(true)
    // The very same call again also asks again: the once-grant was spent.
    const again = call('vo_write', { file_path: 'new.txt', content: 'approved content\n' })
    const p3 = await pendingApproval(id)
    expect(p3.id).not.toBe(p2.id)
    await decide(id, p3, 'reject')
    expect((await again).isError).toBe(true)
    expect(read('new.txt')).toBe('approved content\n')
  })

  it('spends a once-approval exactly once: of two identical writes at the same time one is made and the other is refused as already used', async () => {
    await setup()
    const { id, call } = await session(h)
    const a = call('vo_write', { file_path: 'twice.txt', content: 'same\n' })
    const b = call('vo_write', { file_path: 'twice.txt', content: 'same\n' })
    await decide(id, await pendingApproval(id))
    const results = await Promise.all([a, b])
    expect(results.filter((r) => !r.isError)).toHaveLength(1)
    const refused = results.find((r) => r.isError)!
    expect(refused.content[0].text).toBe('The permission was withdrawn or already used; it was not run.')
    expect(read('twice.txt')).toBe('same\n')
    expect(audit().filter((r) => r.taskId === id && r.action === 'permission.used' && r.tool === 'Write')).toHaveLength(1)
    expect(await status(id)).toBe('running')
  })

  it('keeps bytes exact: non-ASCII text and CRLF line endings are written as sent', async () => {
    await setup()
    const { id, call } = await session(h)
    const content = 'café – ünï\r\nsecond\r\n'
    const pending = call('vo_write', { file_path: 'bytes.txt', content })
    await decide(id, await pendingApproval(id))
    await pending
    expect(readFileSync(file('bytes.txt'))).toEqual(Buffer.from(content, 'utf8'))
  })

  it('overwrites an existing file only after approval', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'notes.txt', content: 'replaced\n' })
    await pendingApproval(id)
    expect(read('notes.txt')).toBe('hello world\nsecond line\nhello again\n')
    await decide(id, await pendingApproval(id))
    await pending
    expect(read('notes.txt')).toBe('replaced\n')
  })
})

describe('an approval does not survive a change to the path between approval and use', () => {
  it('refuses when a parent folder is swapped for a link to somewhere else after the person approved', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'docs/new.md', content: 'would land outside\n' })
    const p = await pendingApproval(id)
    renameSync(file('docs'), file('docs.moved'))
    symlinkSync(outside, file('docs'))
    expect((await decide(id, p)).status).toBe(200)
    const r = await pending
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^(The action changed after it was approved; it was not run\.|That path is not allowed\.)$/)
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('OUTSIDE ORIGINAL\n')
  })

  it('refuses when the target file is swapped for a link to a file outside after the person approved', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'notes.txt', content: 'overwrite the victim\n' })
    const p = await pendingApproval(id)
    renameSync(file('notes.txt'), file('notes.moved'))
    symlinkSync(join(outside, 'victim.txt'), file('notes.txt'))
    await decide(id, p)
    expect((await pending).isError).toBe(true)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('OUTSIDE ORIGINAL\n')
  })

  it('refuses when the workspace folder itself is replaced by a link elsewhere after the person approved', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'moved.txt', content: 'x\n' })
    const p = await pendingApproval(id)
    const root = file('')
    renameSync(root, `${root}-old`)
    symlinkSync(outside, root)
    await decide(id, p)
    expect(await pending).toMatchObject({ isError: true })
    expect(existsSync(join(outside, 'moved.txt'))).toBe(false)
    expect(readdirSync(outside)).toEqual(['victim.txt'])
  })
})

describe('what is refused before anyone is asked', () => {
  it.each([
    ['a sensitive file', { file_path: '.env', content: 'x' }],
    ['a path inside .git', { file_path: '.git/hooks/pre-commit', content: '#!/bin/sh\n' }],
    ['a parent directory', { file_path: '../escape.txt', content: 'x' }],
    ['an absolute path', { file_path: '/tmp/vo-absolute.txt', content: 'x' }],
    ['an existing link out of the workspace', { file_path: 'link.txt', content: 'x' }],
    ['a path through that link', { file_path: 'link.txt/inner', content: 'x' }],
    ['an empty path', { file_path: '', content: 'x' }],
    ['content over 32 KiB', { file_path: 'big.txt', content: 'a'.repeat(32769) }],
    ['content with a secret in it', { file_path: 'secret.txt', content: 'key: sk-ant-api03-abcdefghijklmnop0123' }],
    ['content with a right-to-left override', { file_path: 'bidi.txt', content: 'safe‮evil' }],
    ['content with a control character', { file_path: 'ctl.txt', content: 'a\u0007b' }],
  ])('refuses %s with no approval asked and nothing written', async (_name, args) => {
    await setup()
    const { id, call } = await session(h)
    const r = await call('vo_write', args)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^(The action is not allowed by policy\.|That path is not allowed\.|The tool input is not valid\.)$/)
    expect(await status(id)).toBe('running')
    expect(audit().some((a) => a.taskId === id && a.action === 'approval.requested')).toBe(false)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('OUTSIDE ORIGINAL\n')
    expect(existsSync('/tmp/vo-absolute.txt')).toBe(false)
    expect(existsSync(file('big.txt')) || existsSync(file('secret.txt')) || existsSync(file('bidi.txt')) || existsSync(file('ctl.txt'))).toBe(false)
    expect(read('.env')).toBe('API_TOKEN=should-never-be-read\n')
  })

  it('refuses a deny rule for Write without asking', async () => {
    await setup()
    const { id, call } = await session(h)
    await api('POST', '/api/permissions', { scope: 'global', effect: 'deny', tool: 'Write' })
    expect(await call('vo_write', { file_path: 'new.txt', content: 'x' })).toMatchObject({ isError: true, content: [{ text: 'The action is not allowed by policy.' }] })
    expect(await status(id)).toBe('running')
    expect(existsSync(file('new.txt'))).toBe(false)
  })

  it('has no tool that can run a command, move or delete a file', async () => {
    await setup()
    const { call } = await session(h)
    for (const name of ['vo_run', 'vo_delete', 'vo_move', 'vo_mkdir']) await expect(call(name, { file_path: 'x' })).resolves.toMatchObject({ isError: true })
    expect(existsSync(file('notes.txt'))).toBe(true)
  })
})

describe('edit', () => {
  it('shows the old and new text, changes nothing until approved, then makes exactly that change', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_edit', { file_path: 'notes.txt', old_string: 'second line', new_string: 'SECOND LINE' })
    const p = await pendingApproval(id)
    expect(p).toMatchObject({ tool: 'Edit', review: { kind: 'edit', path: 'notes.txt', oldString: 'second line', newString: 'SECOND LINE' } })
    expect(read('notes.txt')).toBe('hello world\nsecond line\nhello again\n')
    await decide(id, p)
    expect((await pending).content[0].text).toBe('Edited notes.txt.')
    expect(read('notes.txt')).toBe('hello world\nSECOND LINE\nhello again\n')
  })

  it('replaces every match only when the approved edit says so', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_edit', { file_path: 'notes.txt', old_string: 'hello', new_string: 'bye', replace_all: true })
    const p = await pendingApproval(id)
    expect(p.review).toMatchObject({ replaceAll: true })
    await decide(id, p)
    await pending
    expect(read('notes.txt')).toBe('bye world\nsecond line\nbye again\n')
  })

  it.each([
    ['text that is not unique', { old_string: 'hello', new_string: 'x' }, 'The text to replace is not unique; add context or use replace_all.'],
    ['text that is not there', { old_string: 'absent text', new_string: 'x' }, 'No match.'],
  ])('leaves the file alone for %s', async (_name, args, text) => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_edit', { file_path: 'notes.txt', ...args })
    await decide(id, await pendingApproval(id))
    expect(await pending).toMatchObject({ isError: true, content: [{ text }] })
    expect(read('notes.txt')).toBe('hello world\nsecond line\nhello again\n')
  })

  it('refuses to edit a file that is not there, and a link out of the workspace', async () => {
    await setup()
    const { id, call } = await session(h)
    const missing = call('vo_edit', { file_path: 'nope.txt', old_string: 'a', new_string: 'b' })
    await decide(id, await pendingApproval(id))
    expect(await missing).toMatchObject({ isError: true, content: [{ text: 'Not found.' }] })
    expect(await call('vo_edit', { file_path: 'link.txt', old_string: 'OUTSIDE', new_string: 'X' })).toMatchObject({ isError: true })
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('OUTSIDE ORIGINAL\n')
  })
})

describe('what ends a waiting write', () => {
  it('writes nothing when the task is cancelled while the write waits', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'new.txt', content: 'x' })
    await pendingApproval(id)
    await api('POST', `/api/tasks/${id}/cancel`)
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'The task is no longer running.' }] })
    await until(async () => (await status(id)) === 'cancelled')
    expect(existsSync(file('new.txt'))).toBe(false)
  })

  it('writes nothing when nobody answers in time', async () => {
    await setup({ APPROVAL_TIMEOUT_MS: '300' })
    const { id, call } = await session(h)
    expect(await call('vo_write', { file_path: 'new.txt', content: 'x' })).toMatchObject({ isError: true, content: [{ text: 'The approval expired.' }] })
    await until(async () => (await status(id)) === 'failed')
    expect(existsSync(file('new.txt'))).toBe(false)
  })
})

describe('a wider approval, and taking it back', () => {
  it('lets later writes in the same task through after "this task", and asks again once that rule is revoked', async () => {
    await setup()
    const { id, call } = await session(h)
    const first = call('vo_write', { file_path: 'one.txt', content: '1\n' })
    await decide(id, await pendingApproval(id), 'allow_task')
    await first
    const rule = (await api('GET', '/api/permissions')).body.rules.find((r: { scope: string }) => r.scope === 'task')
    expect(rule).toMatchObject({ tool: 'Write', taskId: id })
    expect((await call('vo_write', { file_path: 'two.txt', content: '2\n' })).isError).toBeUndefined()
    expect(read('two.txt')).toBe('2\n')
    expect((await api('DELETE', `/api/permissions/${rule.id}`)).status).toBe(200)
    const third = call('vo_write', { file_path: 'three.txt', content: '3\n' })
    const p = await pendingApproval(id)
    expect(existsSync(file('three.txt'))).toBe(false)
    await decide(id, p, 'reject')
    expect((await third).isError).toBe(true)
    // The sensitive targets stay refused whatever was allowed.
    expect((await call('vo_write', { file_path: '.env', content: 'x' })).isError).toBe(true)
  })

  it('does not let a "this task" approval leak to another task', async () => {
    await setup()
    const a = await session(h, 'agent-demo-backend', 0)
    const first = a.call('vo_write', { file_path: 'one.txt', content: '1\n' })
    await decide(a.id, await pendingApproval(a.id), 'allow_task')
    await first
    const b = await session(h, 'agent-demo-pm', 1)
    const second = b.call('vo_write', { file_path: 'other.txt', content: '2\n' })
    const p = await pendingApproval(b.id)
    expect(p.tool).toBe('Write')
    expect(existsSync(file('other.txt'))).toBe(false)
    await decide(b.id, p, 'reject')
    expect((await second).isError).toBe(true)
  })
})

describe('what is recorded, and what is not', () => {
  it('audits the request, the decision and the use with a digest prefix and a hash, and never the content', async () => {
    await setup()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'new.txt', content: `${CANARY}\n` })
    const p = await pendingApproval(id)
    await decide(id, p)
    await pending
    await until(async () => (await status(id)) === 'running')
    const mine = audit().filter((a) => a.taskId === id && a.tool === 'Write')
    expect(mine.map((a) => a.action)).toEqual(expect.arrayContaining(['tool.asked', 'approval.requested', 'permission.used']))
    expect(audit().find((a) => a.taskId === id && a.action === 'approval.decided')).toMatchObject({ decision: 'allow_once', digest: p.digest!.slice(0, 12), actionHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    const everything = [readFileSync(join(srv().dataDir, AUDIT_FILE), 'utf8'), h.log.lines.join('\n'), JSON.stringify((await api('GET', '/api/state')).body)].join('\n')
    expect(everything).not.toContain(CANARY)
    expect(everything).not.toContain(p.digest!)
    expect(everything).not.toContain(workspaceRoot())
  })
})

describe('files that tools run on their own are approved once, and the queue is asked again', () => {
  const SENTENCE = 'Changes to files that tools run on their own can only be allowed once.'
  const PATHS = ['package.json', '.husky/pre-commit', '.claude/settings.json', 'scripts/build.sh', 'bin/existing']

  async function setupExec() {
    await setup()
    for (const d of ['scripts', 'bin', '.husky', '.claude']) mkdirSync(file(d), { recursive: true })
    writeFileSync(file('bin/existing'), 'echo old\n')
    chmodSync(file('bin/existing'), 0o755)
  }

  it.each(PATHS)('refuses a wider allow for %s, writes nothing, and writes it after "once"', async (path) => {
    await setupExec()
    const { id, call } = await session(h)
    for (const choice of ['allow_task', 'allow_agent']) {
      const pending = call('vo_write', { file_path: path, content: 'x\n' })
      const p = await pendingApproval(id)
      expect(p).toMatchObject({ onceOnly: true })
      const r = await decide(id, p, choice)
      expect(r.status).toBe(422)
      expect(r.body.error).toBe(SENTENCE)
      expect(existsSync(file(path)) && read(path) === 'x\n').toBe(false)
      expect(await status(id)).toBe('waiting_for_approval')
      await decide(id, p, 'reject')
      expect((await pending).isError).toBe(true)
      await until(async () => (await status(id)) === 'running')
    }
    const pending = call('vo_write', { file_path: path, content: 'x\n' })
    expect((await decide(id, await pendingApproval(id))).status).toBe(200)
    expect((await pending).isError).toBeUndefined()
    expect(read(path)).toBe('x\n')
  })

  it('still asks for package.json under a global allow rule, but not for notes.txt', async () => {
    await setupExec()
    // In one scope an ask rule beats an allow rule, so the built-in ask for Write is revoked first.
    expect((await api('DELETE', '/api/permissions/default-write')).status).toBe(200)
    expect((await api('POST', '/api/permissions', { scope: 'global', effect: 'allow', tool: 'Write' })).status).toBe(201)
    const { id, call } = await session(h)
    expect((await call('vo_write', { file_path: 'notes.txt', content: 'free\n' })).isError).toBeUndefined()
    expect(read('notes.txt')).toBe('free\n')
    const pending = call('vo_write', { file_path: 'package.json', content: '{}\n' })
    const p = await pendingApproval(id)
    expect(p.onceOnly).toBe(true)
    expect(existsSync(file('package.json'))).toBe(false)
    await decide(id, p, 'reject')
    await pending
  })

  it('asks again for package.json after "this task" was given for notes.txt', async () => {
    await setupExec()
    const { id, call } = await session(h)
    const first = call('vo_write', { file_path: 'notes.txt', content: '1\n' })
    const p1 = await pendingApproval(id)
    expect(p1.onceOnly).toBe(false)
    await decide(id, p1, 'allow_task')
    await first
    expect((await call('vo_write', { file_path: 'other.txt', content: '2\n' })).isError).toBeUndefined()
    const pending = call('vo_write', { file_path: 'package.json', content: '{}\n' })
    const p = await pendingApproval(id)
    expect(p.onceOnly).toBe(true)
    expect(existsSync(file('package.json'))).toBe(false)
    await decide(id, p, 'reject')
    await pending
  })

  // The queue has no outside signal, so let the in-memory transport and the gate's async steps run to rest before deciding (event-loop turns, not wall-clock time).
  const flush = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)) }

  it('asks again for each write that was already waiting when "this task" was granted', async () => {
    await setupExec()
    const { id, call } = await session(h)
    const a = call('vo_write', { file_path: 'a.txt', content: 'a\n' })
    const pa = await pendingApproval(id)
    const b = call('vo_write', { file_path: 'b.txt', content: 'b\n' })
    const c = call('vo_write', { file_path: 'c.txt', content: 'c\n' })
    await flush()
    await decide(id, pa, 'allow_task')
    expect((await a).isError).toBeUndefined()
    expect(read('a.txt')).toBe('a\n')
    const pb = await pendingApproval(id)
    expect(pb.id).not.toBe(pa.id)
    expect(pb.review).toMatchObject({ path: 'b.txt' })
    expect(existsSync(file('b.txt')) || existsSync(file('c.txt'))).toBe(false)
    await decide(id, pb, 'reject')
    expect((await b).isError).toBe(true)
    await until(async () => (await tasks()).find((t) => t.id === id)?.pendingApproval?.review?.path === 'c.txt')
    const pc = await pendingApproval(id)
    expect(existsSync(file('c.txt'))).toBe(false)
    expect((await decide(id, pc)).status).toBe(200)
    expect((await c).isError).toBeUndefined()
    expect(read('c.txt')).toBe('c\n')
    expect(existsSync(file('b.txt'))).toBe(false)
    // Requests made after the decisions are allowed by the rule as before.
    expect((await call('vo_write', { file_path: 'd.txt', content: 'd\n' })).isError).toBeUndefined()
    expect(read('d.txt')).toBe('d\n')
  })

  it.each([['allow_task'], ['allow_agent']])('refuses %s for a vo_edit of package.json and leaves it unchanged; allow_once edits it', async (choice) => {
    await setupExec()
    writeFileSync(file('package.json'), '{"name":"a"}\n')
    const { id, call } = await session(h)
    const pending = call('vo_edit', { file_path: 'package.json', old_string: '"a"', new_string: '"b"' })
    const p = await pendingApproval(id)
    expect(p.onceOnly).toBe(true)
    const r = await decide(id, p, choice)
    expect(r.status).toBe(422)
    expect(r.body.error).toBe(SENTENCE)
    expect(read('package.json')).toBe('{"name":"a"}\n')
    expect((await decide(id, p)).status).toBe(200)
    expect((await pending).isError).toBeUndefined()
    expect(read('package.json')).toBe('{"name":"b"}\n')
  })

  it('carries onceOnly false for an ordinary file', async () => {
    await setupExec()
    const { id, call } = await session(h)
    const pending = call('vo_write', { file_path: 'plain.txt', content: 'x' })
    const p = await pendingApproval(id)
    expect(p.onceOnly).toBe(false)
    await decide(id, p, 'reject')
    await pending
  })
})

describe('permissions made from an approval belong to one workspace', () => {
  const inDocs = (rel: string) => join(workspaceRoot(), 'docs', rel)
  // An agent has one task at a time, so each is ended before the next starts.
  const cancel = async (id: string) => { expect((await api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202); await until(async () => (await status(id)) === 'cancelled') }

  it('after "allow for this agent" in sandbox, a write in docs asks, and a write in sandbox still runs freely', async () => {
    h = await start({}, undefined, ['docs'])
    const a = await session(h, 'agent-demo-backend', 0, 'sandbox')
    const first = a.call('vo_write', { file_path: 'one.txt', content: '1\n' })
    await decide(a.id, await pendingApproval(a.id), 'allow_agent')
    expect((await first).isError).toBeUndefined()
    expect((await a.call('vo_write', { file_path: 'two.txt', content: '2\n' })).isError).toBeUndefined()
    const rule = (await api('GET', '/api/permissions')).body.rules.find((r: { scope: string }) => r.scope === 'agent')
    expect(rule).toMatchObject({ tool: 'Write', workspaceId: 'sandbox' })
    await cancel(a.id)

    const b = await session(h, 'agent-demo-backend', 1, 'docs')
    const other = b.call('vo_write', { file_path: 'other.txt', content: 'x\n' })
    const p = await pendingApproval(b.id)
    expect(p.tool).toBe('Write')
    expect(existsSync(inDocs('other.txt'))).toBe(false)
    await decide(b.id, p, 'reject')
    expect((await other).isError).toBe(true)
    expect(existsSync(inDocs('other.txt'))).toBe(false)
  })

  it('refuses a rule created through the API for an unknown workspace, with a fixed sentence', async () => {
    h = await start({}, undefined, ['docs'])
    const bad = await api('POST', '/api/permissions', { scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'agent-demo-backend', workspaceId: 'ghost' })
    expect(bad.status).toBe(422)
    expect(bad.body.error).toBe('Unknown workspace.')
    expect(JSON.stringify(bad.body)).not.toContain(workspaceRoot())
    expect((await api('GET', '/api/permissions')).body.rules.some((r: { workspaceId?: string }) => r.workspaceId === 'ghost')).toBe(false)
  })

  it('accepts a rule for a registered workspace, shows it, and applies it there only', async () => {
    h = await start({}, undefined, ['docs'])
    const ok = await api('POST', '/api/permissions', { scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'agent-demo-backend', workspaceId: 'sandbox' })
    expect(ok.status).toBe(201)
    expect(ok.body.rule).toMatchObject({ workspaceId: 'sandbox', scope: 'agent' })
    expect((await api('GET', '/api/permissions')).body.rules.find((r: { id: string }) => r.id === ok.body.rule.id)).toMatchObject({ workspaceId: 'sandbox' })
    // The built-in ask rule for Write is global; an agent rule beats it in its own workspace only.
    const a = await session(h, 'agent-demo-backend', 0, 'sandbox')
    expect((await a.call('vo_write', { file_path: 'free.txt', content: 'ok\n' })).isError).toBeUndefined()
    expect(read('free.txt')).toBe('ok\n')
    await cancel(a.id)
    const b = await session(h, 'agent-demo-pm', 1, 'docs')
    const pm = b.call('vo_write', { file_path: 'pm.txt', content: 'x\n' })
    await decide(b.id, await pendingApproval(b.id), 'reject')
    await pm
    await cancel(b.id)
    const c = await session(h, 'agent-demo-backend', 2, 'docs')
    const docs = c.call('vo_write', { file_path: 'd.txt', content: 'x\n' })
    const p = await pendingApproval(c.id)
    expect(existsSync(inDocs('d.txt'))).toBe(false)
    await decide(c.id, p, 'reject')
    await docs
  })
})
