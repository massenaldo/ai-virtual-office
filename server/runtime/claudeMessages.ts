import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeEvent } from '../../src/workforce/runtime/types'
import { validUsage, type TaskUsage } from '../../src/workforce/types'

// SDK message -> RuntimeEvent, as a pure function. Nothing from the SDK is forwarded as is: text a person sees comes from
// the model's own text blocks (which the task manager redacts and caps) or from the fixed sentences below. The SDK's error
// text, its reasoning and any tool input are never shown.

/** What a session must look like at start: this permission mode and exactly these tools and MCP servers, no more and no fewer. */
export const EXPECTED_MODE = 'dontAsk'
export type SessionExpectation = { tools: readonly string[]; mcpServers: readonly string[] }

const names = (list: readonly string[]): string => list.slice(0, 6).map((n) => n.slice(0, 48)).join(',')

/** Returns why a session's init message is not what was asked for (names only, never content), or null when it is. */
export function initProblem(m: SDKMessage, expected: SessionExpectation): string | null {
  const i = m as unknown as { session_id?: unknown; tools?: unknown; mcp_servers?: unknown; permissionMode?: unknown }
  if (typeof i.session_id !== 'string' || i.session_id === '') return 'the session has no id'
  if (!Array.isArray(i.tools)) return 'the tool list is missing'
  const tools = i.tools.map(String)
  const extra = tools.filter((t) => !expected.tools.includes(t))
  const missing = expected.tools.filter((t) => !tools.includes(t))
  if (extra.length > 0) return `unexpected tools are visible: ${names(extra)}`
  if (missing.length > 0) return `tools are missing: ${names(missing)}`
  if (!Array.isArray(i.mcp_servers)) return 'the mcp server list is missing'
  const servers = (i.mcp_servers as Array<{ name?: unknown; status?: unknown }>).map((x) => String(x?.name))
  if (servers.length !== expected.mcpServers.length || servers.some((n) => !expected.mcpServers.includes(n))) return `unexpected mcp servers: ${names(servers)}`
  if ((i.mcp_servers as Array<{ status?: unknown }>).some((x) => x?.status !== 'connected')) return 'an mcp server is not connected'
  if (i.permissionMode !== EXPECTED_MODE) return `permission mode is ${String(i.permissionMode).slice(0, 24)}, not ${EXPECTED_MODE}`
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
  toolRequested: 'The Claude runtime asked for a tool that is not available.',
  readingResult: 'Reading the result',
} as const

type Block = { type?: unknown; text?: unknown; name?: unknown }

function failure(m: Record<string, unknown>): string {
  const status = typeof m.api_error_status === 'number' ? m.api_error_status : null
  if (status === 401 || status === 403) return COPY.signIn
  if (status === 429) return COPY.rateLimit
  if (m.subtype === 'error_max_turns') return COPY.turns
  if (m.subtype === 'error_max_budget_usd') return COPY.budget
  if (m.subtype === 'error_during_execution') return COPY.execution
  return COPY.generic
}

/** `toolLabels`: the tools the model may call, by the name it uses, each with the text a person sees while it runs. */
export function createMessageMapper(taskId: string, toolLabels: Readonly<Record<string, string>> = {}) {
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
          const events: RuntimeEvent[] = []
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') events.push({ type: 'message', taskId, text: b.text })
            // A tool call shows only its fixed label, never its input. Any tool that is not ours ends the task.
            else if (b.type === 'tool_use') {
              const label = typeof b.name === 'string' && Object.hasOwn(toolLabels, b.name) ? toolLabels[b.name] : null
              if (label === null) return { events: [], violation: COPY.toolRequested }
              events.push({ type: 'progress', taskId, step: 'working', message: label })
            }
          }
          return { events }
        }
        case 'result': {
          const counted = validUsage({ turns: m.num_turns, costUsd: m.total_cost_usd })
          const carried: { usage?: TaskUsage } = counted ? { usage: counted } : {}
          const usage = `turns=${typeof m.num_turns === 'number' ? m.num_turns : 0} cost_usd=${typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0}`
          if (m.subtype === 'success' && m.is_error !== true) {
            const text = typeof m.result === 'string' ? m.result.trim() : ''
            return { events: [{ type: 'completed', taskId, summary: text === '' ? COPY.noText : text, ...carried }], terminal: true, usage }
          }
          return { events: [{ type: 'failed', taskId, error: failure(m), ...carried }], terminal: true, usage }
        }
        case 'user': {
          const content = (m.message as { content?: unknown } | undefined)?.content
          const answered = Array.isArray(content) && (content as Block[]).some((b) => b.type === 'tool_result')
          return answered ? { events: [{ type: 'progress', taskId, step: 'thinking', message: COPY.readingResult }] } : { events: [] }
        }
        case 'permission_denied': return { events: [], note: `The SDK denied a tool call: ${String(m.tool_name ?? 'unknown').slice(0, 64)}` }
        default: return { events: [] }
      }
    },
  }
}
