import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../config'
import { recordingLogger } from '../log'
import { ClaudeAgentRuntimeProvider } from '../runtime/claudeAgent'
import { Secret } from '../secret'
import { startScriptedApi, type ScriptedTurn } from '../test/scriptedApi'
import { startTestServer, tempDataDir, type TestServer } from '../test/helpers'
import { makeWorkspaceRoot } from '../test/workspaces'
import { toolPolicyFrom } from '../toolPolicy'

// The REAL Claude Agent SDK and its bundled binary, in the whole server, against a scripted local API instead of a model: no key
// and no cost. It proves what the fakes cannot: that the real SDK honours our options (tools, permission mode, allowed tools,
// the tool timeout) and that a real tool call goes through the real gate. It starts a child process per test, so it runs only
// when asked:   VO_REAL_SDK=1 npx vitest run server/e2e/claudeRealSdk.test.ts

const KEY = 'sk-ant-api03-canary-0123456789abcdef'
const FILE_SECRET = 'sk-ant-api03-in-a-file-0123456789abcdef'
let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
let api: Awaited<ReturnType<typeof startScriptedApi>> | null = null
afterEach(async () => { await s?.close(); s = null; ws?.cleanup(); ws = null; await api?.close(); api = null })

async function run(script: ScriptedTurn[], env: Record<string, string> = {}) {
  api = await startScriptedApi(script)
  ws = makeWorkspaceRoot(['sandbox'])
  const root = ws.path('sandbox')
  writeFileSync(join(root, 'notes.txt'), `line one\ntoken: ${FILE_SECRET}\n`)
  writeFileSync(join(root, '.env'), 'API_TOKEN=should-never-be-read\n')
  const dir = tempDataDir()
  const full = { ...ws.env, DATA_DIR: dir, RUNTIME: 'claude', ANTHROPIC_API_KEY: KEY, ...env }
  const cfg = parseConfig({ ...full, PORT: '0', OFFICE_ROUTINE: 'off' })
  if (!cfg.ok) throw new Error(cfg.errors.join('; '))
  const log = recordingLogger()
  const provider = new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir, log, protectedRoots: toolPolicyFrom(cfg.config).protectedRoots, toolTimeoutMs: cfg.config.approvalTimeoutMs + 60000, apiBaseUrl: api.url, settings: { model: null, maxTurns: 6, maxBudgetUsd: 1 } })
  s = await startTestServer(full, { provider, log })
  const r = await s.api('POST', '/api/agents/agent-demo-backend/tasks', { title: 'Read the notes', workspaceId: 'sandbox' })
  expect(r.status).toBe(202)
  return { id: r.body.task.id as string, root, log }
}
const task = async (id: string) => ((await s!.api('GET', '/api/state')).body.state.tasks as Array<{ id: string; status: string; resultSummary: string | null; errorMessage: string | null; sessionId: string | null; pendingApproval: { id: string; digest: string | null } | null }>).find((t) => t.id === id)!
async function until(fn: () => Promise<boolean>, ms = 20000) {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 25)) }
}
const toolResults = (requests: Array<{ messages: unknown }>) => JSON.stringify(requests.at(-1)?.messages ?? [])
// The SDK's binary renames its process to plain `claude`, so children are found by parent (this test process) and name.
const childList = () => execSync(`ps --ppid ${process.pid} -o pid=,comm= || true`).toString().split('\n').filter((l) => /\sclaude$/.test(l.trim()) || l.trim().endsWith(' claude')).join('\n')
const children = () => childList().split('\n').filter((l) => l !== '').length

describe.skipIf(!process.env.VO_REAL_SDK)('the real SDK with a scripted API', () => {
  it('sends the model our five tools and no built-in tool', async () => {
    const { id } = await run([[{ text: 'Nothing to do.' }]])
    await until(async () => (await task(id)).status === 'completed')
    const names = api!.requests[0].tools
    expect(names.filter((n) => n.startsWith('mcp__')).sort()).toEqual(['mcp__vo__vo_edit', 'mcp__vo__vo_glob', 'mcp__vo__vo_grep', 'mcp__vo__vo_read', 'mcp__vo__vo_write'])
    for (const builtin of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite']) expect(names).not.toContain(builtin)
    expect((await task(id)).sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('runs a read through the real gate and masks the secret in the file before the model sees it', async () => {
    const { id } = await run([[{ tool: 'mcp__vo__vo_read', input: { file_path: 'notes.txt' } }], [{ text: 'The notes start with line one.' }]])
    await until(async () => (await task(id)).status === 'completed')
    expect((await task(id)).resultSummary).toBe('The notes start with line one.')
    const seen = toolResults(api!.requests)
    expect(seen).toContain('line one')
    expect(seen).not.toContain(FILE_SECRET)
    expect(seen).not.toContain(ws!.root)
  })

  it('gives the model a refusal for a sensitive file and lets it carry on', async () => {
    const { id } = await run([[{ tool: 'mcp__vo__vo_read', input: { file_path: '.env' } }], [{ text: 'I could not read that.' }]])
    await until(async () => (await task(id)).status === 'completed')
    const seen = toolResults(api!.requests)
    expect(seen).toContain('The action is not allowed by policy.')
    expect(seen).not.toContain('should-never-be-read')
  })

  it('stops the task when the model calls a built-in tool, and runs nothing', async () => {
    const marker = join(tempDataDir(), 'pwned')
    const { id } = await run([[{ tool: 'Bash', input: { command: `touch ${marker}` } }], [{ text: 'done' }]])
    await until(async () => (await task(id)).status === 'failed')
    expect((await task(id)).errorMessage).toBe('The Claude runtime asked for a tool that is not available.')
    expect(existsSync(marker)).toBe(false)
  })

  it('waits for a person to approve, longer than a few seconds, then returns the file', async () => {
    const { id } = await run([[{ tool: 'mcp__vo__vo_read', input: { file_path: 'notes.txt' } }], [{ text: 'Read it.' }]])
    await s!.api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })
    // The rule is added after the task started; the model's first turn may already be on its way, so wait for the approval or the end.
    await until(async () => ['waiting_for_approval', 'completed'].includes((await task(id)).status))
    if ((await task(id)).status === 'completed') return
    await new Promise((r) => setTimeout(r, 3000))
    const approval = (await task(id)).pendingApproval!
    expect((await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: approval.id, decision: 'allow_once', digest: approval.digest })).status).toBe(200)
    await until(async () => (await task(id)).status === 'completed')
    expect(toolResults(api!.requests)).toContain('line one')
  })

  it('stops the child process when a task is cancelled while a read waits for approval', async () => {
    const { id } = await run([[{ tool: 'mcp__vo__vo_read', input: { file_path: 'notes.txt' } }], [{ text: 'Read it.' }]])
    await s!.api('POST', '/api/permissions', { scope: 'global', effect: 'ask', tool: 'Read' })
    await until(async () => ['waiting_for_approval', 'completed'].includes((await task(id)).status))
    if ((await task(id)).status !== 'waiting_for_approval') return
    expect(childList()).not.toBe('')
    expect((await s!.api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202)
    await until(async () => (await task(id)).status === 'cancelled')
    await until(async () => children() === 0, 8000)
  })

  it('writes a file only after a person approves exactly that content, through the real SDK', async () => {
    const content = 'Written by the agent.\n'
    const { id, root } = await run([[{ tool: 'mcp__vo__vo_write', input: { file_path: 'out.txt', content } }], [{ text: 'Wrote it.' }]])
    await until(async () => (await task(id)).status === 'waiting_for_approval')
    expect(existsSync(join(root, 'out.txt'))).toBe(false)
    await new Promise((r) => setTimeout(r, 2500))
    expect(existsSync(join(root, 'out.txt'))).toBe(false)
    const approval = (await task(id)).pendingApproval!
    expect((await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: approval.id, decision: 'allow_once', digest: approval.digest })).status).toBe(200)
    await until(async () => (await task(id)).status === 'completed')
    expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe(content)
    expect(toolResults(api!.requests)).toContain('Wrote 22 bytes to out.txt.')
  })

  it('writes nothing when the person rejects, and the model carries on', async () => {
    const { id, root } = await run([[{ tool: 'mcp__vo__vo_write', input: { file_path: 'out.txt', content: 'no\n' } }], [{ text: 'It was refused.' }]])
    await until(async () => (await task(id)).status === 'waiting_for_approval')
    const approval = (await task(id)).pendingApproval!
    await s!.api('POST', `/api/tasks/${id}/approval`, { approvalId: approval.id, decision: 'reject', digest: approval.digest })
    await until(async () => (await task(id)).status === 'completed')
    expect(existsSync(join(root, 'out.txt'))).toBe(false)
    expect(toolResults(api!.requests)).toContain('The action was not approved.')
  })

  it('refuses a write to a sensitive file with no approval asked', async () => {
    const { id, root } = await run([[{ tool: 'mcp__vo__vo_write', input: { file_path: '.env', content: 'API_TOKEN=stolen\n' } }], [{ text: 'Refused.' }]])
    await until(async () => (await task(id)).status === 'completed')
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('API_TOKEN=should-never-be-read\n')
    expect(toolResults(api!.requests)).toContain('The action is not allowed by policy.')
  })

  it('leaves no scratch folder behind', async () => {
    const { id } = await run([[{ text: 'Done.' }]])
    await until(async () => (await task(id)).status === 'completed')
    // The folder goes when the SDK's output ends, which is a moment after the result; wait for it rather than guess.
    await until(async () => !existsSync(join(s!.dataDir, 'claude-scratch', id)), 8000)
  })
})
