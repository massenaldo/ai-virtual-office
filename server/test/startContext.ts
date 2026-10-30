import type { Agent } from '../../src/workforce/types'
import type { StartContext } from '../runtime/types'

export function testStartContext(agent: Agent, overrides: Partial<StartContext> = {}): StartContext {
  return { agent, signal: new AbortController().signal, workspace: null, ...overrides }
}
