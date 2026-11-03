import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn, SessionQuery } from '../runtime/claudeAgent'

/** A stand-in for the SDK's Query that the test drives by hand. Like the real one it throws "Operation aborted" when its AbortController fires. */
export class FakeSession implements SessionQuery {
  readonly options: Options
  readonly prompt: string
  closed = 0
  private queue: Array<{ value?: SDKMessage; error?: Error; end?: true }> = []
  private waiter: (() => void) | null = null

  constructor(params: { prompt: string; options: Options }) {
    this.prompt = params.prompt
    this.options = params.options
    params.options.abortController?.signal.addEventListener('abort', () => this.push({ error: new Error('Operation aborted') }))
  }

  private push(item: { value?: SDKMessage; error?: Error; end?: true }) { this.queue.push(item); this.waiter?.(); this.waiter = null }
  send(m: Record<string, unknown>) { this.push({ value: m as unknown as SDKMessage }) }
  fail(error: Error) { this.push({ error }) }
  end() { this.push({ end: true }) }
  close() { this.closed += 1 }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>((r) => { this.waiter = r })
      const item = this.queue.shift()!
      if (item.error) throw item.error
      if (item.end) return
      yield item.value!
    }
  }
}

export const OUR_TOOLS = ['mcp__vo__vo_read', 'mcp__vo__vo_glob', 'mcp__vo__vo_grep']
export const initMessage = (over: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: OUR_TOOLS, mcp_servers: [{ name: 'vo', status: 'connected', source: 'sdk' }], permissionMode: 'dontAsk', ...over })
export const textMessage = (text: string) => ({ type: 'assistant', session_id: 'sess-1', message: { role: 'assistant', content: [{ type: 'text', text }] } })
export const resultMessage = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'All done.', total_cost_usd: 0.01, num_turns: 1, ...over })

/** A query function that hands out FakeSessions and remembers them. */
export function fakeQuery(onSession?: (s: FakeSession) => void): QueryFn & { sessions: FakeSession[] } {
  const sessions: FakeSession[] = []
  const fn: QueryFn = (params) => {
    const s = new FakeSession(params)
    sessions.push(s)
    onSession?.(s)
    return s
  }
  return Object.assign(fn, { sessions })
}
