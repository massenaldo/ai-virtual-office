/// <reference types="vite/client" />
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import type { AgentTask } from '../../src/workforce/types'
import { recordingLogger } from '../log'
import { Secret } from '../secret'
import { fakeQuery, initMessage, OUR_TOOLS, resultMessage, textMessage } from '../test/fakeClaudeSession'
import { testStartContext } from '../test/startContext'
import type { ResolvedWorkspace } from '../workspaces'
import { ClaudeAgentRuntimeProvider, claudeUnavailableReason, isSdkInstalled, type ClaudeProviderOptions } from './claudeAgent'

const KEY = 'sk-ant-api03-canary-0123456789abcdef'
const demo = createDemoWorkforce('2026-11-03T09:00:00.000Z')
const agent = demo.agents.find((a) => a.id === 'agent-demo-backend')!
const workspace = { id: 'sandbox', path: '/srv/workspaces/sandbox-secret-path' } as ResolvedWorkspace
const taskOf = (title = 'Summarise', description = ''): AgentTask => {
  const r = assignTask(demo, agent.id, { title, description }, '2026-11-03T09:00:00.000Z', { runtime: 'claude', workspaceId: 'sandbox' })
  if (!r.ok) throw new Error(r.error)
  return r.state.tasks[0]
}
const tick = () => new Promise((r) => setTimeout(r, 15))

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vo-claude-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function setup(extra: Partial<ClaudeProviderOptions> = {}) {
  const query = fakeQuery()
  const log = recordingLogger()
  const provider = new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir, query, log, startTimeoutMs: 500, protectedRoots: [dir], ...extra })
  const events: RuntimeEvent[] = []
  provider.subscribe((e) => events.push(e))
  const notes: string[] = []
  const ac = new AbortController()
  const ctx = testStartContext(agent, { workspace, signal: ac.signal, audit: (n) => notes.push(n) })
  const task = taskOf()
  return { provider, query, log, events, notes, ctx, task, ac }
}

/** Starts a session and answers its init message, so the run is going. */
async function started(s: ReturnType<typeof setup>) {
  const pending = s.provider.start(s.task, s.ctx)
  await tick()
  s.query.sessions[0].send(initMessage())
  const outcome = await pending
  return { outcome, session: s.query.sessions[0] }
}

describe('availability', () => {
  it('orders the reasons: the SDK first, then the credentials', () => {
    expect(claudeUnavailableReason(false, false)).toBe('Claude Agent SDK not installed')
    expect(claudeUnavailableReason(false, true)).toBe('Claude Agent SDK not installed')
    expect(claudeUnavailableReason(true, false)).toBe('credentials not configured')
    expect(claudeUnavailableReason(true, true)).toBeNull()
  })
  it('finds the installed SDK', () => {
    expect(isSdkInstalled()).toBe(true)
  })
  it('is unavailable without a key and refuses to start', async () => {
    const p = new ClaudeAgentRuntimeProvider({ dataDir: dir, query: fakeQuery() })
    expect(p.kind).toBe('claude')
    expect(p.availability).toEqual({ available: false, reason: 'credentials not configured' })
    expect(await p.start(taskOf(), testStartContext(agent, { workspace }))).toEqual({ ok: false, error: 'credentials not configured' })
  })
  it('is unavailable when the SDK is missing, even with a key', () => {
    expect(new ClaudeAgentRuntimeProvider({ sdkInstalled: false, apiKey: new Secret(KEY), dataDir: dir }).availability).toEqual({ available: false, reason: 'Claude Agent SDK not installed' })
  })
  it('is available with the SDK and a key', () => {
    expect(new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir }).availability).toEqual({ available: true })
  })
  it('refuses a task with no workspace', async () => {
    const s = setup()
    expect(await s.provider.start(s.task, testStartContext(agent))).toEqual({ ok: false, error: 'The claude runtime needs a workspace.' })
    expect(s.query.sessions).toHaveLength(0)
  })
})

describe('the session it asks for', () => {
  it('has our tools only, no settings, no stored session, an empty working folder and a minimal environment', async () => {
    const s = setup({ settings: { model: 'claude-sonnet-5-5', maxTurns: 5, maxBudgetUsd: 0.25 }, base: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'x', API_TOKEN: 't'.repeat(40) } })
    const { session } = await started(s)
    const o = session.options
    expect(o).toMatchObject({ tools: [], strictMcpConfig: true, permissionMode: 'dontAsk', settingSources: [], persistSession: false, includePartialMessages: false, maxTurns: 5, maxBudgetUsd: 0.25, model: 'claude-sonnet-5-5' })
    expect(o.allowedTools).toEqual(OUR_TOOLS)
    expect(Object.keys(o.mcpServers!)).toEqual(['vo'])
    expect(o.mcpServers!.vo).toMatchObject({ type: 'sdk', name: 'vo' })
    expect(Object.keys(o.env!).sort()).toEqual(['ANTHROPIC_API_KEY', 'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'])
    expect(o.cwd).toBe(join(dir, 'claude-scratch', s.task.id))
    expect(o.cwd).not.toContain('sandbox-secret-path')
    expect(o.env!.CLAUDE_CONFIG_DIR).toBe(join(dir, 'claude-config'))
    expect(o.additionalDirectories).toBeUndefined()
    expect(String(o.systemPrompt)).toContain('vo_read')
    expect(String(o.systemPrompt)).not.toContain('sandbox-secret-path')
    expect(session.prompt).toBe('Summarise')
  })
  it('pre-approves exactly our five tools, none of which can run a command or reach the internet', async () => {
    const s = setup()
    const { session } = await started(s)
    expect(session.options.allowedTools).toEqual(['mcp__vo__vo_read', 'mcp__vo__vo_glob', 'mcp__vo__vo_grep', 'mcp__vo__vo_write', 'mcp__vo__vo_edit'])
    expect(session.options.allowedTools!.join(' ')).not.toMatch(/run|bash|web|fetch|search_web/i)
  })
  it('gives the SDK a tool-call timeout longer than the approval wait', async () => {
    const s = setup({ toolTimeoutMs: 123456 })
    const { session } = await started(s)
    expect((session.options.mcpServers!.vo as { timeout?: number }).timeout).toBe(123456)
    const d = setup()
    const { session: def } = await started(d)
    expect((def.options.mcpServers!.vo as { timeout?: number }).timeout).toBe(360000)
  })
  it('leaves the model and the API address out unless configured', async () => {
    const s = setup()
    const { session } = await started(s)
    expect(session.options).not.toHaveProperty('model')
    expect(session.options.env).not.toHaveProperty('ANTHROPIC_BASE_URL')
  })
  it('denies every tool that is not ours through the PreToolUse hook, lets ours through to the gate, and sets no permission callback the SDK would never call', async () => {
    const s = setup()
    const { session } = await started(s)
    expect(session.options.canUseTool).toBeUndefined()
    const hook = session.options.hooks!.PreToolUse![0].hooks[0]
    const call = (input: unknown) => hook(input as never, undefined, { signal: new AbortController().signal })
    for (const bad of ['Bash', 'Write', 'Edit', 'mcp__vo__vo_run', 'mcp__vo__vo_delete', 'mcp__other__vo_write']) await expect(call({ tool_name: bad })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    await expect(call({})).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    await expect(call(null)).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    for (const good of OUR_TOOLS) await expect(call({ tool_name: good })).resolves.toEqual({})
  })
  it('creates the working folder with no other access and removes it when the session ends', async () => {
    const s = setup()
    const { session } = await started(s)
    expect(existsSync(join(dir, 'claude-scratch', s.task.id))).toBe(true)
    session.send(resultMessage())
    session.end()
    await s.provider.dispose()
    await tick()
    expect(existsSync(join(dir, 'claude-scratch', s.task.id))).toBe(false)
  })
  it('points the SDK at a scripted API only when told to', async () => {
    const s = setup({ apiBaseUrl: 'http://127.0.0.1:9' })
    const { session } = await started(s)
    expect(session.options.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
  })
})

describe('a task that goes well', () => {
  it('starts, streams the agent text, completes and reports numbers only', async () => {
    const s = setup()
    const { outcome, session } = await started(s)
    expect(outcome).toMatchObject({ ok: true, sessionId: 'sess-1' })
    expect(outcome.ok && outcome.executionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.provider.status(s.task.id)).toMatchObject({ state: 'running', sessionId: 'sess-1' })
    session.send({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', id: 'u1', name: 'mcp__vo__vo_read', input: { file_path: 'plan.md' } }] } })
    session.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'file text' }] } })
    session.send(textMessage('Hello there.'))
    session.send(resultMessage({ result: 'Hello there.' }))
    session.end()
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['started', 'progress', 'progress', 'message', 'completed'])
    expect(s.events[1]).toEqual({ type: 'progress', taskId: s.task.id, step: 'working', message: 'Reading a file' })
    expect(JSON.stringify(s.events)).not.toContain('plan.md')
    expect(s.events[0]).toMatchObject({ type: 'started', sessionId: 'sess-1' })
    expect(s.events[4]).toEqual({ type: 'completed', taskId: s.task.id, summary: 'Hello there.', usage: { turns: 1, costUsd: 0.01 } })
    expect(s.provider.status(s.task.id)).toMatchObject({ state: 'ended', outcome: 'completed' })
    expect(s.provider.result(s.task.id)).toEqual({ outcome: 'completed', summary: 'Hello there.' })
    expect(s.notes).toEqual(['Claude session started (session sess-1)', 'Claude session ended: turns=1 cost_usd=0.01'])
    expect(session.closed).toBeGreaterThan(0)
  })
  it('ignores the error the SDK throws after a result, and every message after the end', async () => {
    const s = setup()
    const { session } = await started(s)
    session.send(resultMessage({ is_error: true, api_error_status: 401, result: `Invalid API key ${KEY}` }))
    session.send(textMessage('late'))
    session.fail(new Error('Claude Code returned an error result: Invalid API key'))
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['started', 'failed'])
    expect(s.events[1]).toEqual({ type: 'failed', taskId: s.task.id, error: 'The Claude runtime could not sign in. Check the API key.', usage: { turns: 1, costUsd: 0.01 } })
    expect(s.provider.result(s.task.id)).toEqual({ outcome: 'failed', error: 'The Claude runtime could not sign in. Check the API key.' })
  })
})

describe('a session that must not run', () => {
  it('fails before it starts when the init message shows a tool that is not ours, and closes the session', async () => {
    const s = setup()
    const pending = s.provider.start(s.task, s.ctx)
    await tick()
    s.query.sessions[0].send(initMessage({ tools: [...OUR_TOOLS, 'Bash', 'Write'] }))
    expect(await pending).toEqual({ ok: false, error: 'The Claude runtime started with an unexpected configuration.' })
    await tick()
    expect(s.events).toEqual([])
    expect(s.query.sessions[0].closed).toBeGreaterThan(0)
    expect(s.notes[0]).toBe('The Claude session was not started: unexpected tools are visible: Bash,Write')
  })
  it.each([
    ['one of our tools is missing', { tools: ['mcp__vo__vo_read'] }, 'tools are missing'],
    ['no tool is listed', { tools: [] }, 'tools are missing'],
    ['another MCP server is attached', { mcp_servers: [{ name: 'vo', status: 'connected' }, { name: 'x', status: 'connected' }] }, 'unexpected mcp servers'],
    ['our server did not connect', { mcp_servers: [{ name: 'vo', status: 'failed' }] }, 'not connected'],
    ['the mode is not dontAsk', { permissionMode: 'acceptEdits' }, 'permission mode'],
  ])('fails before it starts when %s', async (_n, over, word) => {
    const s = setup()
    const pending = s.provider.start(s.task, s.ctx)
    await tick()
    s.query.sessions[0].send(initMessage(over))
    expect(await pending).toEqual({ ok: false, error: 'The Claude runtime started with an unexpected configuration.' })
    expect(s.notes[0]).toContain(word)
    expect(s.query.sessions[0].closed).toBeGreaterThan(0)
  })
  it('fails before it starts when the key is refused (a result with no init)', async () => {
    const s = setup()
    const pending = s.provider.start(s.task, s.ctx)
    await tick()
    s.query.sessions[0].send(resultMessage({ is_error: true, api_error_status: 401 }))
    expect(await pending).toEqual({ ok: false, error: 'The Claude runtime could not sign in. Check the API key.' })
    expect(s.events).toEqual([])
  })
  it('fails the task when the model asks for a tool that is not ours', async () => {
    const s = setup()
    const { session } = await started(s)
    session.send({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'rm -rf /' } }] } })
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['started', 'failed'])
    expect(JSON.stringify(s.events)).not.toContain('rm -rf')
    expect(session.closed).toBeGreaterThan(0)
  })
  it('fails when the session throws before a result, with a fixed sentence and the detail only in the log', async () => {
    const s = setup()
    const { session } = await started(s)
    session.fail(new Error(`spawn failed at /srv/workspaces/sandbox-secret-path with ${KEY}`))
    await tick()
    expect(s.events[1]).toEqual({ type: 'failed', taskId: s.task.id, error: 'The Claude runtime stopped with an error.' })
    expect(JSON.stringify(s.events)).not.toContain('sandbox-secret-path')
  })
  it('fails when the session ends without a result', async () => {
    const s = setup()
    const { session } = await started(s)
    session.end()
    await tick()
    expect(s.events[1]).toEqual({ type: 'failed', taskId: s.task.id, error: 'The Claude runtime ended without a result.' })
  })
  it('gives up when the SDK sends nothing in time', async () => {
    const s = setup({ startTimeoutMs: 30 })
    expect(await s.provider.start(s.task, s.ctx)).toEqual({ ok: false, error: 'The Claude runtime did not start in time.' })
    expect(s.query.sessions[0].closed).toBeGreaterThan(0)
  })
  it('refuses to start without a protected root, so a mis-wired server cannot expose its data folder', async () => {
    const s = setup({ protectedRoots: [] })
    expect(await s.provider.start(s.task, s.ctx)).toEqual({ ok: false, error: 'Runtime failed to start.' })
    expect(s.query.sessions).toHaveLength(0)
    expect(existsSync(join(dir, 'claude-scratch', s.task.id))).toBe(false)
  })
  it('fails when the SDK cannot be started at all', async () => {
    const s = setup({ query: () => { throw new Error(`cannot spawn ${KEY}`) } })
    expect(await s.provider.start(s.task, s.ctx)).toEqual({ ok: false, error: 'Runtime failed to start.' })
    expect(existsSync(join(dir, 'claude-scratch', s.task.id))).toBe(false)
  })
})

describe('cancel and shutdown', () => {
  it('cancels a running session once, stops the child, and sends nothing afterwards', async () => {
    const s = setup()
    const { session } = await started(s)
    s.provider.cancel(s.task.id)
    s.provider.cancel(s.task.id)
    session.send(textMessage('too late'))
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['started', 'cancelled'])
    expect(session.options.abortController!.signal.aborted).toBe(true)
    expect(session.closed).toBeGreaterThan(0)
    expect(s.provider.status(s.task.id)).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    expect(s.provider.result(s.task.id)).toEqual({ outcome: 'cancelled' })
  })
  it('cancels when the task signal aborts (timeout or forced cancel)', async () => {
    const s = setup()
    await started(s)
    s.ac.abort()
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['started', 'cancelled'])
  })
  it('cancels a session that was still starting', async () => {
    const s = setup()
    const pending = s.provider.start(s.task, s.ctx)
    await tick()
    s.provider.cancel(s.task.id)
    expect(await pending).toMatchObject({ ok: true })
    await tick()
    expect(s.events.map((e) => e.type)).toEqual(['cancelled'])
  })
  it('stops every running session on dispose and waits for them', async () => {
    const s = setup()
    await started(s)
    await s.provider.dispose()
    expect(s.query.sessions[0].closed).toBeGreaterThan(0)
    expect(s.provider.status(s.task.id)).toMatchObject({ outcome: 'cancelled' })
  })
  it('knows nothing about a task it never ran, and has no approvals to answer', () => {
    const s = setup()
    expect(s.provider.status('nope')).toEqual({ state: 'unknown' })
    expect(s.provider.result('nope')).toBeNull()
    expect(() => s.provider.respondToApproval('t', 'a', 'approve')).not.toThrow()
  })
})

describe('secrets', () => {
  it('never lets the key or a server path reach an event, an audit note or a log line', async () => {
    const s = setup()
    const { session } = await started(s)
    session.send(resultMessage({ is_error: true, api_error_status: 401, result: `bad key ${KEY}` }))
    session.fail(new Error(`bad key ${KEY}`))
    await tick()
    const everything = JSON.stringify([s.events, s.notes])
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain('sandbox-secret-path')
    expect(s.log.lines.join('\n')).not.toContain('sandbox-secret-path')
  })
  it('holds no other way to start a process: the source never names one', () => {
    const source = readFileSync(new URL('./claudeAgent.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|fork\(/)
  })
})
