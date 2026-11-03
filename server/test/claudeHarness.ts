import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { AUDIT_FILE, type AuditRecord } from '../audit'
import { parseConfig } from '../config'
import { recordingLogger } from '../log'
import { ClaudeAgentRuntimeProvider } from '../runtime/claudeAgent'
import { Secret } from '../secret'
import { toolPolicyFrom } from '../toolPolicy'
import { fakeQuery, initMessage } from './fakeClaudeSession'
import { startTestServer, tempDataDir, type TestServer } from './helpers'
import { makeWorkspaceRoot } from './workspaces'

// The claude runtime inside the whole server with a fake SDK session, and a real MCP client on the session's own tool server, so a
// test calls the tools the way the SDK would: through the real gate, permission rules, approval flow and file operations.

export const KEY = 'sk-ant-api03-canary-0123456789abcdef'
export const FILE_SECRET = 'sk-ant-api03-in-a-file-0123456789abcdef'
export const FORGE = 'agent-demo-backend'

let server: TestServer | null = null
let wsHandle: ReturnType<typeof makeWorkspaceRoot> | null = null
const clients: Client[] = []

export type Harness = { query: ReturnType<typeof fakeQuery>; log: ReturnType<typeof recordingLogger>; dir: string; root: string }

/** A server on the claude runtime with a fake session, and a workspace `sandbox` seeded with a few files (or with `seed`). */
export async function start(env: Record<string, string> = {}, seed?: (root: string) => void): Promise<Harness> {
  wsHandle = makeWorkspaceRoot(['sandbox'])
  const root = wsHandle.path('sandbox')
  if (seed) seed(root)
  else {
    writeFileSync(join(root, 'notes.txt'), `line one\nline two\ntoken: ${FILE_SECRET}\n`)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const needle = 1\n')
    writeFileSync(join(root, '.env'), 'API_TOKEN=should-never-be-read\n')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'needle in git\n')
    symlinkSync('/etc/hostname', join(root, 'link.txt'))
  }
  const dir = tempDataDir()
  const query = fakeQuery()
  const log = recordingLogger()
  const full = { ...wsHandle.env, DATA_DIR: dir, RUNTIME: 'claude', ANTHROPIC_API_KEY: KEY, ...env }
  const probe = parseConfig({ ...full, PORT: '0' })
  if (!probe.ok) throw new Error(probe.errors.join('; '))
  const provider = new ClaudeAgentRuntimeProvider({ apiKey: new Secret(KEY), dataDir: dir, query, log, protectedRoots: toolPolicyFrom(probe.config).protectedRoots, toolTimeoutMs: probe.config.approvalTimeoutMs + 60000 })
  server = await startTestServer(full, { provider, log })
  return { query, log, dir, root }
}

export async function stop(): Promise<void> {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await server?.close()
  server = null
  wsHandle?.cleanup()
  wsHandle = null
}

export const srv = (): TestServer => server!
export const workspaceRoot = (): string => wsHandle!.root
export const api = (method: string, path: string, body?: unknown) => server!.api(method, path, body)
export type TaskView = { id: string; status: string; pendingApproval: { id: string; tool: string; digest: string | null; review: { kind: string; path: string; content?: string; oldString?: string; newString?: string; workspaceId: string; digest: string } | null } | null }
export const tasks = async () => (await api('GET', '/api/state')).body.state.tasks as TaskView[]
export const audit = (): AuditRecord[] => readFileSync(join(server!.dataDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

export async function until(fn: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 10)) }
}

export type ToolCall = { isError?: boolean; content: Array<{ text: string }> }

/** Starts a task, answers the session's init, and returns an MCP client on the session's own tool server. */
export async function session(h: Harness, agent = FORGE, index = 0) {
  const r = await api('POST', `/api/agents/${agent}/tasks`, { title: 'Work on the notes', workspaceId: 'sandbox' })
  expect(r.status).toBe(202)
  await until(async () => h.query.sessions.length > index)
  const fake = h.query.sessions[index]
  fake.send(initMessage())
  const id = r.body.task.id as string
  await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'running')
  const toolServer = fake.options.mcpServers!.vo as unknown as { instance: { connect(t: unknown): Promise<void> } }
  const [a, b] = InMemoryTransport.createLinkedPair()
  await toolServer.instance.connect(b)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(a)
  clients.push(client)
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolCall
  return { id, fake, call, text: async (name: string, args: Record<string, unknown>) => (await call(name, args)).content[0].text }
}

/** Waits for the task to ask for approval and returns what the person would see. */
export async function pendingApproval(id: string) {
  await until(async () => (await tasks()).find((t) => t.id === id)?.status === 'waiting_for_approval')
  return (await tasks()).find((t) => t.id === id)!.pendingApproval!
}
