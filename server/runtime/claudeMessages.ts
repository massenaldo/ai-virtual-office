import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'

// SDK message -> RuntimeEvent, as a pure function. Nothing from the SDK is forwarded as is: text a person sees comes from
// the model's own text blocks (which the task manager redacts and caps) or from the fixed sentences below. The SDK's error
// text, its reasoning and any tool input are never shown.

/** What a session must look like at start. In this stage the model has no tools at all. */
export const EXPECTED_INIT = { permissionMode: 'dontAsk', tools: [] as string[], mcpServers: [] as string[] }

/** Returns why a session's init message is not what was asked for (names only, never content), or null when it is. */
export function initProblem(m: SDKMessage): string | null {
  const i = m as unknown as { session_id?: unknown; tools?: unknown; mcp_servers?: unknown; permissionMode?: unknown }
  if (typeof i.session_id !== 'string' || i.session_id === '') return 'the session has no id'
  const tools = Array.isArray(i.tools) ? i.tools : null
  if (tools === null || tools.length !== EXPECTED_INIT.tools.length) return `tools are visible: ${Array.isArray(i.tools) ? i.tools.slice(0, 8).map(String).join(',') : 'unknown'}`
  const servers = Array.isArray(i.mcp_servers) ? i.mcp_servers : null
  if (servers === null || servers.length !== EXPECTED_INIT.mcpServers.length) return 'an mcp server is attached'
  if (i.permissionMode !== EXPECTED_INIT.permissionMode) return `permission mode is ${String(i.permissionMode).slice(0, 24)}, not ${EXPECTED_INIT.permissionMode}`
  return null
}

export type Mapped = {
  events: RuntimeEvent[]
  /** Set for the system/init message. */
  init?: { sessionId: string }
  /** True when the events end the task (completed or failed). */
  terminal?: true
  /** Numbers only: turns and the SDK's cost estimate. For the audit log. */
  usage?: string
  /** The session did something it must not (asked for a tool); the provider stops it and fails the task. */
  violation?: string
  /** Something for the audit log that is not an event. */
  note?: string
}

const COPY = {
  signIn: 'The Claude runtime could not sign in. Check the API key.',
  rateLimit: 'The Claude service is rate limiting this server. Try again shortly.',
  generic: 'The Claude runtime reported an error.',
  turns: 'The agent reached its step limit.',
  budget: 'The agent reached its spending limit.',
  execution: 'The Claude runtime stopped with an error.',
  noText: 'The agent finished without a written answer.',
  retry: 'Waiting for the Claude service',
  toolRequested: 'The Claude runtime asked for a tool, and no tool is available.',
} as const

type Block = { type?: unknown; text?: unknown }

function failure(m: Record<string, unknown>): string {
  const status = typeof m.api_error_status === 'number' ? m.api_error_status : null
  if (status === 401 || status === 403) return COPY.signIn
  if (status === 429) return COPY.rateLimit
  if (m.subtype === 'error_max_turns') return COPY.turns
  if (m.subtype === 'error_max_budget_usd') return COPY.budget
  if (m.subtype === 'error_during_execution') return COPY.execution
  return COPY.generic
}

export function createMessageMapper(taskId: string) {
  return {
    map(message: SDKMessage): Mapped {
      const m = message as unknown as Record<string, unknown>
      switch (m.type) {
        case 'system': {
          if (m.subtype === 'init') return { events: [], init: { sessionId: String(m.session_id ?? '') } }
          if (m.subtype === 'api_retry') return { events: [{ type: 'progress', taskId, step: 'thinking', message: COPY.retry }] }
          return { events: [] }
        }
        case 'assistant': {
          // A message the API itself produced for an error (for example a bad key) is not the agent speaking.
          if (m.error !== undefined || m.is_api_error_message === true) return { events: [] }
          const content = (m.message as { content?: unknown } | undefined)?.content
          const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : []
          if (blocks.some((b) => b.type === 'tool_use')) return { events: [], violation: COPY.toolRequested }
          const events: RuntimeEvent[] = []
          for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') events.push({ type: 'message', taskId, text: b.text })
          return { events }
        }
        case 'result': {
          const usage = `turns=${typeof m.num_turns === 'number' ? m.num_turns : 0} cost_usd=${typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0}`
          if (m.subtype === 'success' && m.is_error !== true) {
            const text = typeof m.result === 'string' ? m.result.trim() : ''
            return { events: [{ type: 'completed', taskId, summary: text === '' ? COPY.noText : text }], terminal: true, usage }
          }
          return { events: [{ type: 'failed', taskId, error: failure(m) }], terminal: true, usage }
        }
        case 'permission_denied': return { events: [], note: `The SDK denied a tool call: ${String(m.tool_name ?? 'unknown').slice(0, 64)}` }
        default: return { events: [] }
      }
    },
  }
}
