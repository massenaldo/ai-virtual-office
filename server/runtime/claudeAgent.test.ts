/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import { testStartContext } from '../test/startContext'
import { ClaudeAgentRuntimeProvider, claudeUnavailableReason } from './claudeAgent'

const source = Object.values(import.meta.glob<string>('./claudeAgent.ts', { query: '?raw', import: 'default', eager: true }))[0]

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
    expect(await provider.start(r.state.tasks[0], testStartContext(demo.agents[0]))).toEqual({ ok: false, error: 'Claude Agent SDK not installed' })
    expect(provider.status(r.state.tasks[0].id)).toEqual({ state: 'unknown' })
    expect(provider.result(r.state.tasks[0].id)).toBeNull()
    provider.cancel('task-1')
    provider.respondToApproval('task-1', 'a', 'approve')
    off()
    await provider.dispose()
    expect(heard).toEqual([])
  })

  it('orders the unavailable reasons', () => {
    expect(claudeUnavailableReason(false, false)).toBe('Claude Agent SDK not installed')
    expect(claudeUnavailableReason(false, true)).toBe('Claude Agent SDK not installed')
    expect(claudeUnavailableReason(true, false)).toBe('credentials not configured')
    expect(claudeUnavailableReason(true, true)).toBe('Claude Agent SDK integration is not implemented yet')
  })

  it('stays not installed even with credentials', () => {
    expect(new ClaudeAgentRuntimeProvider({ credentialsConfigured: true }).availability).toEqual({ available: false, reason: 'Claude Agent SDK not installed' })
  })

  it('documents the boundary', () => {
    for (const word of ['requestToolApproval', 'ctx.workspace.path', 'canUseTool', 'AbortController', 'CANCEL_GRACE_MS']) expect(source).toContain(word)
  })
})

