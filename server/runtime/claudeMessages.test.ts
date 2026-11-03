import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createMessageMapper, EXPECTED_INIT, initProblem } from './claudeMessages'

// Messages shaped like the ones a real 0.3.317 session sent in a recorded run (init, an authentication failure, the result), plus the
// documented shapes for the rest. Only the fields the mapper reads are filled in.
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const init = (over: Record<string, unknown> = {}) => msg({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [], mcp_servers: [], permissionMode: 'dontAsk', ...over })
const assistant = (content: unknown[], over: Record<string, unknown> = {}) => msg({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content }, ...over })
const result = (over: Record<string, unknown> = {}) => msg({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'All done.', total_cost_usd: 0.0123, num_turns: 1, ...over })

describe('initProblem', () => {
  it('accepts exactly the expected session', () => {
    expect(initProblem(init())).toBeNull()
  })
  it.each([
    ['a tool is visible', { tools: ['Bash'] }, 'tools'],
    ['an MCP server is attached', { mcp_servers: [{ name: 'x', status: 'connected' }] }, 'mcp'],
    ['the permission mode is not dontAsk', { permissionMode: 'default' }, 'mode'],
    ['there is no session id', { session_id: '' }, 'session'],
  ])('refuses when %s', (_name, over, word) => {
    expect(initProblem(init(over))).toContain(word)
  })
  it('states what it expects', () => {
    expect(EXPECTED_INIT).toEqual({ permissionMode: 'dontAsk', tools: [], mcpServers: [] })
  })
})

describe('createMessageMapper', () => {
  const map = (m: SDKMessage) => createMessageMapper('t1').map(m)

  it('maps init to started carrying the session id', () => {
    expect(map(init())).toMatchObject({ init: { sessionId: 'sess-1' }, events: [] })
  })

  it('maps assistant text to one message per text block and skips empty ones', () => {
    expect(map(assistant([{ type: 'text', text: 'Hello' }, { type: 'text', text: '  ' }, { type: 'text', text: 'World' }])).events).toEqual([
      { type: 'message', taskId: 't1', text: 'Hello' },
      { type: 'message', taskId: 't1', text: 'World' },
    ])
  })

  it('does not show reasoning', () => {
    expect(map(assistant([{ type: 'thinking', thinking: 'secret plan' }])).events).toEqual([])
  })

  it('does not show an API error message as agent text; the result carries the cause', () => {
    expect(map(assistant([{ type: 'text', text: 'Invalid API key · Fix external API key' }], { error: 'authentication_failed', api_error_status: 401 })).events).toEqual([])
  })

  it('treats a tool call as a violation, because no tool exists in this session', () => {
    const r = map(assistant([{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }]))
    expect(r.violation).toBe('The Claude runtime asked for a tool, and no tool is available.')
    expect(r.events).toEqual([])
  })

  it('maps a success result to completed with the final text, and reports usage as numbers only', () => {
    const r = map(result())
    expect(r.events).toEqual([{ type: 'completed', taskId: 't1', summary: 'All done.' }])
    expect(r.terminal).toBe(true)
    expect(r.usage).toBe('turns=1 cost_usd=0.0123')
  })

  it('gives a success result with no text a fixed summary', () => {
    expect(map(result({ result: '' })).events).toEqual([{ type: 'completed', taskId: 't1', summary: 'The agent finished without a written answer.' }])
  })

  it.each([
    ['an authentication failure', { is_error: true, api_error_status: 401, result: 'Invalid API key · Fix external API key' }, 'The Claude runtime could not sign in. Check the API key.'],
    ['a permission failure', { is_error: true, api_error_status: 403 }, 'The Claude runtime could not sign in. Check the API key.'],
    ['a rate limit', { is_error: true, api_error_status: 429 }, 'The Claude service is rate limiting this server. Try again shortly.'],
    ['any other error result', { is_error: true }, 'The Claude runtime reported an error.'],
    ['the turn limit', { subtype: 'error_max_turns', is_error: true }, 'The agent reached its step limit.'],
    ['the spending limit', { subtype: 'error_max_budget_usd', is_error: true }, 'The agent reached its spending limit.'],
    ['a failure during execution', { subtype: 'error_during_execution', is_error: true }, 'The Claude runtime stopped with an error.'],
    ['an unknown subtype', { subtype: 'something_new', is_error: true }, 'The Claude runtime reported an error.'],
  ])('maps %s to failed with a fixed sentence and never the SDK text', (_n, over, expected) => {
    const r = map(result(over))
    expect(r.events).toEqual([{ type: 'failed', taskId: 't1', error: expected }])
    expect(r.terminal).toBe(true)
    expect(JSON.stringify(r)).not.toContain('Invalid API key')
  })

  it('shows retries and rate limits as thinking, with fixed text', () => {
    expect(map(msg({ type: 'system', subtype: 'api_retry' })).events).toEqual([{ type: 'progress', taskId: 't1', step: 'thinking', message: 'Waiting for the Claude service' }])
  })

  it('ignores every message type it does not know', () => {
    for (const type of ['stream_event', 'user', 'tool_progress', 'something_new']) expect(map(msg({ type }))).toEqual({ events: [] })
  })

  it('notes a permission denial for the audit log, since none should happen', () => {
    expect(map(msg({ type: 'permission_denied', tool_name: 'Bash' })).note).toBe('The SDK denied a tool call: Bash')
  })
})
