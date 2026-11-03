import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import type { GatedAction, GatedOutcome, ToolRequest } from './types'
import { createVoServer, MODEL_TOOL_NAMES, TOOL_LABELS, toCallToolResult, VO_SERVER_NAME } from './claudeTools'

// The tool server as the model sees it, driven through a real MCP client over an in-memory transport, with a stand-in gate.

type Use = (request: ToolRequest, perform: (a: GatedAction) => unknown) => Promise<GatedOutcome<unknown>>
const calls: ToolRequest[] = []
let allow: Use = async (request, perform) => ({ behavior: 'allow', outcome: 'allowed', value: await perform({ tool: request.tool, input: request.input, workspace: null, signal: new AbortController().signal, paths: [] }) })
const gate = { use: ((request: ToolRequest, perform: (a: GatedAction) => unknown) => { calls.push(request); return allow(request, perform) }) as never }

const clients: Client[] = []
async function connect(timeoutMs = 7000) {
  calls.length = 0
  const server = createVoServer(sdk, { tools: gate as never }, { protectedRoots: ['/data'], timeoutMs })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(b)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(a)
  clients.push(client)
  return { server, client }
}
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())) })

describe('the tool server', () => {
  it('is named vo and carries the SDK timeout it was given', async () => {
    const { server } = await connect(4321)
    expect(server).toMatchObject({ type: 'sdk', name: VO_SERVER_NAME, timeout: 4321 })
  })

  it('offers exactly five tools: three marked read-only and two marked as changing files, with plain descriptions', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => `mcp__${VO_SERVER_NAME}__${t.name}`).sort()).toEqual([...MODEL_TOOL_NAMES].sort())
    expect(Object.keys(TOOL_LABELS).sort()).toEqual([...MODEL_TOOL_NAMES].sort())
    for (const t of tools) {
      const writes = t.name === 'vo_write' || t.name === 'vo_edit'
      expect(t.annotations).toMatchObject(writes ? { readOnlyHint: false, destructiveHint: true } : { readOnlyHint: true, destructiveHint: false })
      expect(t.description).toMatch(/workspace/)
      expect(t.description).not.toMatch(/\/(home|data|srv|tmp|Users)\b/)
    }
    expect(tools.map((t) => t.name).join(' ')).not.toMatch(/run|bash|fetch|web/)
  })

  it('tells the model that a person approves every change', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    for (const name of ['vo_write', 'vo_edit']) expect(tools.find((t) => t.name === name)!.description).toMatch(/must approve/)
  })

  it('describes the arguments of each tool', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties).sort()
    expect(props('vo_read')).toEqual(['file_path', 'limit', 'offset'])
    expect(props('vo_glob')).toEqual(['path', 'pattern'])
    expect(props('vo_grep')).toEqual(['-i', 'glob', 'output_mode', 'path', 'pattern'])
    expect(props('vo_write')).toEqual(['content', 'file_path'])
    expect(props('vo_edit')).toEqual(['file_path', 'new_string', 'old_string', 'replace_all'])
  })

  it('sends each call through the gate under the policy name of the tool, and returns what the handler produced', async () => {
    const { client } = await connect()
    allow = async (request) => ({ behavior: 'allow', outcome: 'allowed', value: `handled ${request.tool}` }) as never
    // The handlers wrap `perform`; here the stand-in gate answers directly, so only the routing is checked.
    const r = await client.callTool({ name: 'vo_read', arguments: { file_path: 'a.txt' } })
    expect(calls).toEqual([{ tool: 'Read', input: { file_path: 'a.txt' } }])
    expect(r).toMatchObject({ content: [{ type: 'text', text: 'handled Read' }] })
    await client.callTool({ name: 'vo_glob', arguments: { pattern: '*.ts' } })
    await client.callTool({ name: 'vo_grep', arguments: { pattern: 'x' } })
    await client.callTool({ name: 'vo_write', arguments: { file_path: 'a.txt', content: 'c' } })
    await client.callTool({ name: 'vo_edit', arguments: { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true } })
    expect(calls.map((c) => c.tool)).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit'])
    expect(calls[3]).toEqual({ tool: 'Write', input: { file_path: 'a.txt', content: 'c' } })
    expect(calls[4]).toEqual({ tool: 'Edit', input: { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true } })
  })

  it('turns a refusal by the gate into an error result with a fixed sentence the model can read', async () => {
    const { client } = await connect()
    allow = async () => ({ behavior: 'deny', outcome: 'denied_by_policy', message: 'Tool "Read" is not allowed: path /srv/secret/x not in the workspace' })
    const r = await client.callTool({ name: 'vo_read', arguments: { file_path: '.env' } })
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The action is not allowed by policy.' }] })
    expect(JSON.stringify(r)).not.toContain('/srv/secret')
  })

  it.each([
    ['denied', 'The action was not approved.'],
    ['expired', 'The approval expired.'],
    ['cancelled', 'The task is no longer running.'],
    ['stale_approval', 'The action changed after it was approved; it was not run.'],
    ['revoked', 'The permission was withdrawn or already used; it was not run.'],
  ])('maps the gate outcome %s to its own sentence', async (outcome, text) => {
    const { client } = await connect()
    allow = async () => ({ behavior: 'deny', outcome, message: 'internal wording' }) as never
    expect(await client.callTool({ name: 'vo_read', arguments: { file_path: 'a' } })).toMatchObject({ isError: true, content: [{ text }] })
  })

  it('refuses the wrong shape of arguments before the gate is asked', async () => {
    const { client } = await connect()
    for (const [name, args] of [['vo_read', { file_path: 3 }], ['vo_read', {}], ['vo_read', { file_path: 'a', offset: 0 }], ['vo_glob', { pattern: ['x'] }], ['vo_grep', { pattern: 'x', output_mode: 'regex' }], ['vo_write', { file_path: 'a' }], ['vo_write', { file_path: 'a', content: 5 }], ['vo_edit', { file_path: 'a', old_string: 'x' }], ['vo_edit', { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: 'yes' }]] as const) {
      const r = await client.callTool({ name, arguments: args as never }).catch((e: unknown) => ({ isError: true, thrown: String(e) }))
      expect(r).toMatchObject({ isError: true })
    }
    expect(calls).toEqual([])
  })

  it('has no tool for running a command, deleting or moving a file, or any built-in tool', async () => {
    const { client } = await connect()
    for (const name of ['vo_run', 'vo_delete', 'vo_move', 'vo_mkdir', 'Bash', 'Write', 'Edit']) {
      const r = await client.callTool({ name, arguments: {} }).catch((e: unknown) => ({ isError: true, thrown: String(e) }))
      expect(r).toMatchObject({ isError: true })
    }
    expect(calls).toEqual([])
  })

  it('shapes a result as MCP text, marking only failures as errors', () => {
    expect(toCallToolResult({ ok: true, text: 'hello' })).toEqual({ content: [{ type: 'text', text: 'hello' }] })
    expect(toCallToolResult({ ok: false, error: 'not_found', text: 'Not found.' })).toEqual({ content: [{ type: 'text', text: 'Not found.' }], isError: true })
  })

  it('refuses to be built without a protected root, so a mis-wired provider fails loudly', () => {
    expect(() => createVoServer(sdk, { tools: gate as never }, { protectedRoots: [], timeoutMs: 1000 })).toThrow('protectedRoots must not be empty')
  })
})
