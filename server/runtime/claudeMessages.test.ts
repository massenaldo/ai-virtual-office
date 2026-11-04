import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { createMessageMapper, EXPECTED_MODE, initProblem } from './claudeMessages'

// Messages shaped like the ones a real 0.3.317 session sent in a recorded run (init, an authentication failure, the result), plus the
// documented shapes for the rest. Only the fields the mapper reads are filled in.
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage
const TOOLS = { 'mcp__vo__vo_read': 'Reading a file', 'mcp__vo__vo_grep': 'Searching files' }
const EXPECT = { tools: ['mcp__vo__vo_read', 'mcp__vo__vo_grep'], mcpServers: ['vo'] }
const init = (over: Record<string, unknown> = {}) => msg({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['mcp__vo__vo_grep', 'mcp__vo__vo_read'], mcp_servers: [{ name: 'vo', status: 'connected', source: 'sdk' }], permissionMode: 'dontAsk', ...over })
const assistant = (content: unknown[], over: Record<string, unknown> = {}) => msg({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content }, ...over })
const result = (over: Record<string, unknown> = {}) => msg({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'All done.', total_cost_usd: 0.0123, num_turns: 1, ...over })

describe('initProblem', () => {
  it('accepts exactly the expected session, whatever the order of the tools', () => {
    expect(initProblem(init(), EXPECT)).toBeNull()
  })
  it.each([
    ['a built-in tool is visible', { tools: ['mcp__vo__vo_grep', 'mcp__vo__vo_read', 'Bash'] }, 'unexpected tools are visible: Bash'],
    ['another of our tools is visible', { tools: ['mcp__vo__vo_grep', 'mcp__vo__vo_read', 'mcp__vo__vo_write'] }, 'unexpected tools are visible: mcp__vo__vo_write'],
    ['a tool is missing', { tools: ['mcp__vo__vo_read'] }, 'tools are missing: mcp__vo__vo_grep'],
    ['the tool list is missing', { tools: undefined }, 'the tool list is missing'],
    ['a second MCP server is attached', { mcp_servers: [{ name: 'vo', status: 'connected' }, { name: 'evil', status: 'connected' }] }, 'unexpected mcp servers: vo,evil'],
    ['the MCP server has another name', { mcp_servers: [{ name: 'other', status: 'connected' }] }, 'unexpected mcp servers: other'],
    ['the MCP server is not connected', { mcp_servers: [{ name: 'vo', status: 'failed' }] }, 'an mcp server is not connected'],
    ['the permission mode is not dontAsk', { permissionMode: 'default' }, 'permission mode is default, not dontAsk'],
    ['there is no session id', { session_id: '' }, 'the session has no id'],
  ])('refuses when %s', (_name, over, expected) => {
    expect(initProblem(init(over), EXPECT)).toBe(expected)
  })
  it('expects the dontAsk mode', () => {
    expect(EXPECTED_MODE).toBe('dontAsk')
  })
  it('with nothing expected, refuses any tool', () => {
    expect(initProblem(init(), { tools: [], mcpServers: [] })).toContain('unexpected tools')
  })
})

describe('createMessageMapper', () => {
  const map = (m: SDKMessage) => createMessageMapper('t1', TOOLS).map(m)

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

  it('shows a call to one of our tools as its fixed label only, never the input', () => {
    const r = map(assistant([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'u1', name: 'mcp__vo__vo_read', input: { file_path: 'secret/plan.md' } }]))
    expect(r.events).toEqual([{ type: 'message', taskId: 't1', text: 'Let me look.' }, { type: 'progress', taskId: 't1', step: 'working', message: 'Reading a file' }])
    expect(JSON.stringify(r)).not.toContain('secret/plan.md')
    expect(r.violation).toBeUndefined()
  })

  it.each(['Bash', 'Write', 'mcp__vo__vo_write', 'mcp__other__vo_read', 'toString', '__proto__', ''])('treats a call to %j as a violation', (name) => {
    const r = map(assistant([{ type: 'tool_use', id: 'u1', name, input: { command: 'ls' } }]))
    expect(r.violation).toBe('The Claude runtime asked for a tool that is not available.')
    expect(r.events).toEqual([])
  })

  it('treats a nameless tool call as a violation', () => {
    expect(map(assistant([{ type: 'tool_use', id: 'u1' }])).violation).toBeDefined()
  })

  it('shows a tool result as the agent thinking, with fixed text', () => {
    expect(map(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'file text with a secret' }] } })).events).toEqual([{ type: 'progress', taskId: 't1', step: 'thinking', message: 'Reading the result' }])
  })

  it('ignores a user message that is not a tool result', () => {
    expect(map(msg({ type: 'user', message: { content: 'hello' } }))).toEqual({ events: [] })
  })

  it('maps a success result to completed with the final text, and reports usage as numbers only', () => {
    const r = map(result())
    expect(r.events).toEqual([{ type: 'completed', taskId: 't1', summary: 'All done.', usage: { turns: 1, costUsd: 0.0123 } }])
    expect(r.terminal).toBe(true)
    expect(r.usage).toBe('turns=1 cost_usd=0.0123')
  })

  it('gives a success result with no text a fixed summary', () => {
    expect(map(result({ result: '' })).events).toEqual([{ type: 'completed', taskId: 't1', summary: 'The agent finished without a written answer.', usage: { turns: 1, costUsd: 0.0123 } }])
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
    expect(r.events).toEqual([{ type: 'failed', taskId: 't1', error: expected, usage: { turns: 1, costUsd: 0.0123 } }])
    expect(r.terminal).toBe(true)
    expect(JSON.stringify(r)).not.toContain('Invalid API key')
  })

  it.each([
    ['success', {}],
    ['failure', { is_error: true }],
  ])('puts no usage on a %s result that lacks the numbers', (_n, over) => {
    const r = map(result({ ...over, num_turns: undefined, total_cost_usd: undefined }))
    expect(r.events[0]).not.toHaveProperty('usage')
  })

  it.each([
    ['negative cost', { total_cost_usd: -1 }],
    ['NaN cost', { total_cost_usd: NaN }],
    ['infinite cost', { total_cost_usd: Infinity }],
    ['absurd cost', { total_cost_usd: 5000 }],
    ['string cost', { total_cost_usd: '0.1' }],
    ['negative turns', { num_turns: -2 }],
    ['fractional turns', { num_turns: 1.5 }],
    ['absurd turns', { num_turns: 100000 }],
    ['string turns', { num_turns: '3' }],
  ])('puts no usage on a result with %s', (_n, over) => {
    expect(map(result(over)).events[0]).not.toHaveProperty('usage')
    expect(map(result({ ...over, is_error: true })).events[0]).not.toHaveProperty('usage')
  })

  it('shows retries and rate limits as thinking, with fixed text', () => {
    expect(map(msg({ type: 'system', subtype: 'api_retry' })).events).toEqual([{ type: 'progress', taskId: 't1', step: 'thinking', message: 'Waiting for the Claude service' }])
  })

  it('ignores every message type it does not know', () => {
    for (const type of ['stream_event', 'tool_progress', 'something_new']) expect(map(msg({ type }))).toEqual({ events: [] })
  })

  it('notes a permission denial for the audit log, since none should happen', () => {
    expect(map(msg({ type: 'permission_denied', tool_name: 'Bash' })).note).toBe('The SDK denied a tool call: Bash')
  })
})
