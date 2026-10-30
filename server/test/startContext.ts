import type { Agent } from '../../src/workforce/types'
import type { StartContext } from '../runtime/types'
import { DEFAULT_ALLOWED_TOOLS } from '../toolPolicy'

export function testStartContext(agent: Agent, overrides: Partial<StartContext> = {}): StartContext {
  return {
    agent,
    signal: new AbortController().signal,
    workspace: null,
    tools: { allowedTools: new Set(DEFAULT_ALLOWED_TOOLS) },
    requestToolApproval: () => Promise.resolve({ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }),
    audit: () => {},
    ...overrides,
  }
}
