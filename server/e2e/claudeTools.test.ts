import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE, type AuditRecord } from '../audit'
import { recordingLogger } from '../log'
import { ClaudeAgentRuntimeProvider } from '../runtime/claudeAgent'
import { Secret } from '../secret'
import { fakeQuery, initMessage } from '../test/fakeClaudeSession'
import { startTestServer, tempDataDir, type TestServer } from '../test/helpers'
import { makeWorkspaceRoot } from '../test/workspaces'
import { toolPolicyFrom } from '../toolPolicy'

// The read tools of the claude runtime inside the whole server: a real MCP client calls the same tool server the SDK would, the
// calls go through the real gate, permission rules, approval flow and file operations, and a real workspace is read.

const KEY = 'sk-ant-api03-canary-0123456789abcdef'
const FILE_SECRET = 'sk-ant-api03-in-a-file-0123456789abcdef'
const FORGE = 'agent-demo-backend'
let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); await s?.close(); s = null; ws?.cleanup(); ws = null })

// startTestServer takes the provider in its deps; the provider needs the server's config, so it is built from the same values.
async function start(env: Record<string, string> = {}) {
  ws = makeWorkspaceRoot(['sandbox'])
  const root = ws.path('sandbox')
  writeFileSync(join(root, 'notes.txt'), `line one\nline two\ntoken: ${FILE_SECRET}\n`)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const needle = 1\n')
  writeFileSync(join(root, '.env'), 'API_TOKEN=should-never-be-read\n')
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), 'needle in git\n')
  symlinkSync('/etc/hostname', join(root, 'link.txt'))
  const dir = tempDataDir()
  const query = fakeQuery()
  const log = recordingLogger()
  const full = { ...ws.env, DATA_DIR: dir, RUNTIME: 'claude', ANTHROPIC_API_KEY: KEY, ...env }
  const probe = await import('../config').then((m) => m.parseConfig({ ...full, PORT: '0' }))
  if (!probe.ok) throw new Error(probe.errors.join('; '))
  const provider = new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir, query, log, protectedRoots: toolPolicyFrom(probe.config).protectedRoots, toolTimeoutMs: probe.config.approvalTimeoutMs + 60000 })
  s = await startTestServer(full, { provider, log })
  return { query, log, dir, root }
}

const api = (method: string, path: string, body?: unknown) => s!.api(method, path, body)
const tasks = async () => (await api('GET', '/api/state')).body.state.tasks as Array<{ id: string; status: string; pendingApproval: { id: string; tool: string; digest: string | null; review: unknown } | null }>
async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 10)) }
}
/** Starts a task, answers the session's init, and returns an MCP client on the session's own tool server. */
async function session(ctx: Awaited<ReturnType<typeof start>>, agent = FORGE, index = 0) {
  const r = await api('POST', `/api/agents/${agent}/tasks`, { title: 'Read the notes', workspaceId: 'sandbox' })
  expect(r.status).toBe(202)
  await until(async () => ctx.query.sessions.length > index)
  const fake = ctx.query.sessions[index]
  fake.send(initMessage())
  const id = r.body.task.id as string
  await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'running')
  const server = fake.options.mcpServers!.vo as unknown as { instance: { connect(t: unknown): Promise<void> } }
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(b)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(a)
  clients.push(client)
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
  return { id, fake, call, text: async (name: string, args: Record<string, unknown>) => (await call(name, args)).content[0].text }
}
const audit = (): AuditRecord[] => readFileSync(join(s!.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

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
    for (const t of [glob, grep]) expect(t).not.toContain(ws!.root)
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
    expect(JSON.stringify(r)).not.toContain(ws!.root)
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
    const everything = [JSON.stringify(results), JSON.stringify((await api('GET', '/api/state')).body), readFileSync(join(s!.dataDir, AUDIT_FILE), 'utf8'), ctx.log.lines.join('\n')].join('\n')
    for (const secret of [KEY, FILE_SECRET, ws!.root, s!.dataDir]) expect(everything).not.toContain(secret)
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
