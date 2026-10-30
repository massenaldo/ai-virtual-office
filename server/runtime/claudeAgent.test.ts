import { describe, expect, it } from 'vitest'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import { ClaudeAgentRuntimeProvider } from './claudeAgent'

describe('ClaudeAgentRuntimeProvider', () => {
  it('reports unavailable and refuses to start', async () => {
    const demo = createDemoWorkforce('2026-10-31T09:00:00.000Z')
    const r = assignTask(demo, 'agent-demo-backend', { title: 'Build API', description: '' }, '2026-10-31T09:00:00.000Z', { runtime: 'claude' })
    if (!r.ok) throw new Error(r.error)
    const provider = new ClaudeAgentRuntimeProvider()
    const heard: unknown[] = []
    const off = provider.subscribe((e) => heard.push(e))
    expect(provider.kind).toBe('claude')
    expect(provider.availability).toEqual({ available: false, reason: 'Claude Agent SDK not installed' })
    expect(await provider.start(r.state.tasks[0], { agent: demo.agents[0], signal: new AbortController().signal })).toEqual({ ok: false, error: 'Claude Agent SDK not installed' })
    expect(provider.status(r.state.tasks[0].id)).toEqual({ state: 'unknown' })
    expect(provider.result(r.state.tasks[0].id)).toBeNull()
    provider.cancel('task-1')
    provider.respondToApproval('task-1', 'a', 'approve')
    off()
    await provider.dispose()
    expect(heard).toEqual([])
  })
})
