import type { Agent } from '../../src/workforce/types'
import type { StartContext } from '../runtime/types'

export function testStartContext(agent: Agent, overrides: Partial<StartContext> = {}): StartContext {
  return {
    agent,
    signal: new AbortController().signal,
    workspace: null,
    tools: { use: () => Promise.resolve({ behavior: 'deny', outcome: 'cancelled', message: 'The task is no longer running.' }) },
    audit: () => {},
    ...overrides,
  }
}
