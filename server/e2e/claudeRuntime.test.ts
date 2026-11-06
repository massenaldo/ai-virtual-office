import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_FILE } from '../audit'
import { recordingLogger } from '../log'
import { ClaudeAgentRuntimeProvider } from '../runtime/claudeAgent'
import { Secret } from '../secret'
import { fakeQuery, initMessage, resultMessage, textMessage } from '../test/fakeClaudeSession'
import { startTestServer, tempDataDir, type TestServer } from '../test/helpers'
import { openEventStream, type SseStream } from '../test/sseClient'
import { makeWorkspaceRoot } from '../test/workspaces'

// The claude runtime inside the whole server: real HTTP, the real task manager and event stream, and a fake SDK session driven
// by the test. What it proves is the wiring (status, events, cancel, timeout, secrets); the real SDK is exercised by hand.

const KEY = 'sk-ant-api03-canary-0123456789abcdef'
const FORGE = 'agent-demo-backend'
const PM = 'agent-demo-pm'
let s: TestServer | null = null
let ws: ReturnType<typeof makeWorkspaceRoot> | null = null
const streams: SseStream[] = []
afterEach(async () => { streams.splice(0).forEach((x) => x.close()); await s?.close(); s = null; ws?.cleanup(); ws = null })

async function boot(env: Record<string, string> = {}) {
  ws = makeWorkspaceRoot(['sandbox'])
  const dir = tempDataDir()
  const query = fakeQuery()
  const log = recordingLogger()
  const provider = new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir, query, log, protectedRoots: [dir] })
  s = await startTestServer({ ...ws.env, DATA_DIR: dir, RUNTIME: 'claude', ANTHROPIC_API_KEY: KEY, ...env }, { provider, log })
  const stream = await openEventStream(s.url, { token: s.app.apiToken.value })
  streams.push(stream)
  return { query, stream, log, dir }
}
const tasks = async () => (await s!.api('GET', '/api/state')).body.state.tasks as Array<{ id: string; agentId: string; status: string; runtime: string; sessionId: string | null; executionId: string | null; resultSummary: string | null; errorMessage: string | null; endedReason: string | null; usage: { turns: number; costUsd: number } | null }>
async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 10)) }
}
async function begin(agent = FORGE) {
  const r = await s!.api('POST', `/api/agents/${agent}/tasks`, { title: 'Summarise the plan', description: 'Two lines.', workspaceId: 'sandbox' })
  expect(r.status).toBe(202)
  return r.body.task.id as string
}
const sessionAt = async (q: ReturnType<typeof fakeQuery>, i: number) => { await until(async () => q.sessions.length > i); return q.sessions[i] }

describe('the claude runtime in the whole server', () => {
  it('is available, and the task runs from start to completion with the session id on the task', async () => {
    const { query, stream } = await boot()
    expect((await s!.api('GET', '/api/health')).body).toMatchObject({ runtime: 'claude', available: true })
    const id = await begin()
    const session = await sessionAt(query, 0)
    expect(session.prompt).toBe('Summarise the plan\n\nTwo lines.')
    expect((await tasks())[0]).toMatchObject({ status: 'starting', runtime: 'claude' })
    session.send(initMessage({ session_id: 'sess-42' }))
    await until(async () => (await tasks())[0].status === 'running')
    expect((await tasks())[0]).toMatchObject({ sessionId: 'sess-42', runtime: 'claude' })
    session.send(textMessage('Plan: ship it.'))
    session.send(resultMessage({ result: 'Plan: ship it.', num_turns: 4, total_cost_usd: 0.0456 }))
    session.end()
    const seen = await stream.until((e) => e.type === 'task.completed', 3000)
    expect((await tasks())[0]).toMatchObject({ id, status: 'completed', resultSummary: 'Plan: ship it.', endedReason: 'completed', usage: { turns: 4, costUsd: 0.0456 } })
    expect((seen.at(-1) as { patch: { tasks: unknown[] } }).patch.tasks[0]).toMatchObject({ id, usage: { turns: 4, costUsd: 0.0456 } })
    const state = (await s!.api('GET', '/api/state')).body.state
    expect(state.agents.find((a: { id: string }) => a.id === FORGE).status).toBe('idle')
    expect(JSON.stringify(state.activities)).toContain('Plan: ship it.')
  })

  it('runs two agents at once with a session each', async () => {
    const { query } = await boot()
    await begin(FORGE)
    await begin(PM)
    const [a, b] = [await sessionAt(query, 0), await sessionAt(query, 1)]
    a.send(initMessage({ session_id: 'a' })); b.send(initMessage({ session_id: 'b' }))
    await until(async () => (await tasks()).every((t) => t.status === 'running'))
    expect((await tasks()).map((t) => t.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('cancels a running task: the session is stopped, the task ends cancelled, and nothing more arrives', async () => {
    const { query, stream } = await boot()
    const id = await begin()
    const session = await sessionAt(query, 0)
    session.send(initMessage())
    await until(async () => (await tasks())[0].status === 'running')
    expect((await s!.api('POST', `/api/tasks/${id}/cancel`)).status).toBe(202)
    await stream.until((e) => e.type === 'task.cancelled', 3000)
    session.send(textMessage('too late'))
    await new Promise((r) => setTimeout(r, 50))
    expect(session.options.abortController!.signal.aborted).toBe(true)
    expect(session.closed).toBeGreaterThan(0)
    expect((await tasks())[0]).toMatchObject({ status: 'cancelled' })
    expect(JSON.stringify((await s!.api('GET', '/api/state')).body.state.activities)).not.toContain('too late')
  })

  it('ends a task that runs past its time limit and stops the session', async () => {
    const { query, stream } = await boot({ TASK_TIMEOUT_MS: '300' })
    await begin()
    const session = await sessionAt(query, 0)
    session.send(initMessage())
    await stream.until((e) => e.type === 'task.failed', 3000)
    expect((await tasks())[0]).toMatchObject({ status: 'failed', endedReason: 'timeout' })
    expect(session.options.abortController!.signal.aborted).toBe(true)
  })

  it('fails the task with a fixed sentence when the key is refused, and the key is nowhere', async () => {
    const { query, stream, log } = await boot()
    await begin()
    const session = await sessionAt(query, 0)
    session.send({ type: 'assistant', error: 'authentication_failed', api_error_status: 401, message: { content: [{ type: 'text', text: `Invalid API key ${KEY}` }] } })
    session.send(resultMessage({ is_error: true, api_error_status: 401, result: `Invalid API key ${KEY}` }))
    session.fail(new Error(`Claude Code returned an error result: Invalid API key ${KEY}`))
    await stream.until((e) => e.type === 'task.failed', 3000)
    expect((await tasks())[0]).toMatchObject({ status: 'failed', errorMessage: 'The Claude runtime could not sign in. Check the API key.' })
    const everything = [JSON.stringify((await s!.api('GET', '/api/state')).body), readFileSync(join(s!.dataDir, AUDIT_FILE), 'utf8'), log.lines.join('\n'), JSON.stringify(stream.events)].join('\n')
    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(ws!.root)
  })

  it('stops a session whose init shows a tool, before the task ever runs', async () => {
    const { query, stream } = await boot()
    await begin()
    const session = await sessionAt(query, 0)
    session.send(initMessage({ tools: ['Bash'] }))
    await stream.until((e) => e.type === 'task.failed', 3000)
    expect((await tasks())[0]).toMatchObject({ status: 'failed', errorMessage: 'The Claude runtime started with an unexpected configuration.' })
    expect(session.closed).toBeGreaterThan(0)
  })

  it('writes the session start and end to the audit log as numbers and ids only', async () => {
    const { query, stream } = await boot()
    const id = await begin()
    const session = await sessionAt(query, 0)
    session.send(initMessage({ session_id: 'sess-9' }))
    session.send(resultMessage({ result: 'Done.' }))
    session.end()
    await stream.until((e) => e.type === 'task.completed', 3000)
    const audit = readFileSync(join(s!.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.taskId === id && r.action === 'runtime.note')
    expect(audit.map((r) => r.detail)).toEqual(['Claude session started (session sess-9)', 'Claude session ended: turns=1 cost_usd=0.01'])
  })
})
