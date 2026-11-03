import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE } from '../audit'
import { api, audit, FILE_SECRET, KEY, session, srv, start, stop, tasks, until, workspaceRoot } from '../test/claudeHarness'

// The read tools of the claude runtime inside the whole server: a real MCP client calls the same tool server the SDK would, the
// calls go through the real gate, permission rules, approval flow and file operations, and a real workspace is read.

afterEach(stop)

describe('the read tools in the whole server', () => {
  it('reads a file in the workspace without asking, masks a secret in it, and audits the call', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    const r = await call('vo_read', { file_path: 'notes.txt' })
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toContain('line two')
    expect(r.content[0].text).not.toContain(FILE_SECRET)
    expect(r.content[0].text).toContain('[REDACTED]')
    const used = audit().filter((a) => a.taskId === id && a.tool === 'Read')
    expect(used.map((a) => a.action)).toEqual(expect.arrayContaining(['tool.allowed', 'permission.used']))
    expect(used.find((a) => a.action === 'tool.allowed')).toMatchObject({ decision: 'allow', digest: expect.stringMatching(/^[0-9a-f]{12}$/), actionHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((await tasks()).find((t) => t.id === id)!.status).toBe('running')
  })

  it('lists and searches with workspace-relative paths, and never shows sensitive entries or a host path', async () => {
    const ctx = await start()
    const { text } = await session(ctx)
    const glob = await text('vo_glob', { pattern: '**/*' })
    expect(glob).toContain('notes.txt')
    expect(glob).toContain('src/a.ts')
    expect(glob).not.toContain('.env')
    expect(glob).not.toContain('.git')
    const grep = await text('vo_grep', { pattern: 'needle', output_mode: 'content' })
    expect(grep).toContain('src/a.ts:1:')
    expect(grep).not.toContain('git')
    for (const t of [glob, grep]) expect(t).not.toContain(workspaceRoot())
  })

  it.each([
    ['a sensitive file', 'vo_read', { file_path: '.env' }],
    ['a file inside .git', 'vo_read', { file_path: '.git/config' }],
    ['a parent directory', 'vo_read', { file_path: '../outside.txt' }],
    ['an absolute path', 'vo_read', { file_path: '/etc/passwd' }],
    ['a symlink out of the workspace', 'vo_read', { file_path: 'link.txt' }],
    ['a glob over a parent directory', 'vo_glob', { pattern: '*', path: '..' }],
    ['a search from an absolute path', 'vo_grep', { pattern: 'root', path: '/etc' }],
  ])('refuses %s with a fixed sentence and no path', async (_name, tool, args) => {
    const ctx = await start()
    const { call } = await session(ctx)
    const r = await call(tool, args)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/^(The action is not allowed by policy\.|That path is not allowed\.)$/)
    expect(JSON.stringify(r)).not.toContain('should-never-be-read')
    expect(JSON.stringify(r)).not.toContain(workspaceRoot())
  })

  it('hands the model a refusal it can read and the task goes on running', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    await call('vo_read', { file_path: '.env' })
    expect((await tasks()).find((t) => t.id === id)!.status).toBe('running')
    expect(audit().some((a) => a.taskId === id && a.action === 'tool.denied')).toBe(true)
  })

  it('obeys a deny rule for Read', async () => {
    const ctx = await start()
    const { call } = await session(ctx)
    expect((await api('POST', '/api/permissions', { scope: 'global', effect: 'deny', tool: 'Read' })).status).toBe(201)
    const r = await call('vo_read', { file_path: 'notes.txt' })
    expect(r).toMatchObject({ isError: true, content: [{ text: 'The action is not allowed by policy.' }] })
  })

  it('waits for a person when a rule says ask, and returns the file once it is approved for this action only', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    expect((await api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })).status).toBe(201)
    const pending = call('vo_read', { file_path: 'notes.txt' })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
    const approval = (await tasks()).find((t) => t.id === id)!.pendingApproval!
    expect(approval).toMatchObject({ tool: 'Read', digest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((await api('POST', `/api/tasks/${id}/approval`, { approvalId: approval.id, decision: 'allow_once', digest: approval.digest })).status).toBe(200)
    const r = await pending
    expect(r.isError).toBeUndefined()
    expect(r.content[0].text).toContain('line one')
    // The once-grant is spent: the same read asks again.
    const again = call('vo_read', { file_path: 'notes.txt' })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
    const second = (await tasks()).find((t) => t.id === id)!.pendingApproval!
    expect(second.id).not.toBe(approval.id)
    await api('POST', `/api/tasks/${id}/approval`, { approvalId: second.id, decision: 'reject', digest: second.digest })
    expect(await again).toMatchObject({ isError: true, content: [{ text: 'The action was not approved.' }] })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'running')
  })

  it('refuses an approval whose digest is for a different action', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    await api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })
    const pending = call('vo_read', { file_path: 'notes.txt' })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
    const approval = (await tasks()).find((t) => t.id === id)!.pendingApproval!
    expect((await api('POST', `/api/tasks/${id}/approval`, { approvalId: approval.id, decision: 'allow_once', digest: '0'.repeat(64) })).status).toBe(409)
    expect((await tasks()).find((t) => t.id === id)!.status).toBe('waiting_for_approval')
    await api('POST', `/api/tasks/${id}/cancel`)
    await pending
  })

  it('ends a read that is waiting for approval when the task is cancelled', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    await api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })
    const pending = call('vo_read', { file_path: 'notes.txt' })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
    expect((await api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202)
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'The task is no longer running.' }] })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'cancelled')
  })

  it('fails the task when an approval is not answered in time, and the waiting read ends', async () => {
    const ctx = await start({ APPROVAL_TIMEOUT_MS: '300' })
    const { id, call } = await session(ctx)
    await api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })
    const r = await call('vo_read', { file_path: 'notes.txt' })
    expect(r).toMatchObject({ isError: true, content: [{ text: 'The approval expired.' }] })
    await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'failed')
  })

  it('runs two reads at once and answers each', async () => {
    const ctx = await start()
    const { call } = await session(ctx)
    const [a, b] = await Promise.all([call('vo_read', { file_path: 'notes.txt' }), call('vo_grep', { pattern: 'needle' })])
    expect(a.content[0].text).toContain('line one')
    expect(b.content[0].text).toContain('src/a.ts')
  })

  it('keeps the key and every host path out of state, the audit log, the log and every tool result', async () => {
    const ctx = await start()
    const { id, call } = await session(ctx)
    const results = [await call('vo_read', { file_path: 'notes.txt' }), await call('vo_glob', { pattern: '*' }), await call('vo_read', { file_path: '/etc/passwd' })]
    const everything = [JSON.stringify(results), JSON.stringify((await api('GET', '/api/state')).body), readFileSync(join(srv().dataDir, AUDIT_FILE), 'utf8'), ctx.log.lines.join('\n')].join('\n')
    for (const secret of [KEY, FILE_SECRET, workspaceRoot(), srv().dataDir]) expect(everything).not.toContain(secret)
    expect(id).toBeTruthy()
  })
})

describe('the limit on running Claude tasks', () => {
  it('refuses a task over the limit with a clear message, and accepts one after another ends', async () => {
    const ctx = await start({ MAX_CONCURRENT_TASKS: '1' })
    const first = await session(ctx)
    const refused = await api('POST', '/api/agents/agent-demo-pm/tasks', { title: 'Second', workspaceId: 'sandbox' })
    expect(refused).toMatchObject({ status: 409, body: { error: 'A Claude task is already running, which is the limit. Wait for one to finish.' } })
    expect((await tasks())).toHaveLength(1)
    expect((await api('POST', `/api/tasks/${first.id}/cancel`)).status).toBe(202)
    await until(async () => (await tasks())[0].status === 'cancelled')
    expect((await api('POST', '/api/agents/agent-demo-pm/tasks', { title: 'Third', workspaceId: 'sandbox' })).status).toBe(202)
  })
})
