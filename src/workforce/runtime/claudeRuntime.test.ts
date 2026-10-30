/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import type { Agent, AgentTask } from '../types'
import { CLAUDE_UNAVAILABLE, ClaudeRuntimeProvider } from './claudeRuntime'

// Every non-test workforce source, read through Vite like src/scene/noRemoteAssets.test.ts.
const sources = import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
const FORBIDDEN = [/\bfetch\(/, /child_process/, /XMLHttpRequest/, /new WebSocket/, /apiKey/i, /ANTHROPIC_/]

const NOW = '2026-10-30T09:00:00.000Z'
const agent: Agent = { id: 'agent-1', name: 'Forge', role: 'API engineer', department: 'backend', deskId: null, status: 'idle', currentTaskId: 'task-1', runtimeMode: 'real', demo: false, createdAt: NOW, lastActivityAt: null }
const task: AgentTask = { id: 'task-1', agentId: 'agent-1', title: 'Build API', description: '', status: 'queued', createdAt: NOW, startedAt: null, completedAt: null, resultSummary: null, errorMessage: null, executionId: null }

describe('ClaudeRuntimeProvider', () => {
  it('reports unavailable and never starts', () => {
    const p = new ClaudeRuntimeProvider()
    const heard: unknown[] = []
    const off = p.subscribe((e) => heard.push(e))
    expect(p.mode).toBe('real')
    expect(p.availability).toEqual({ available: false, reason: 'Not available: requires a server-side runtime.' })
    expect(CLAUDE_UNAVAILABLE).toBe('Not available: requires a server-side runtime.')
    expect(p.start(task, agent)).toEqual({ ok: false, error: CLAUDE_UNAVAILABLE })
    p.cancel('task-1')
    off()
    p.dispose()
    expect(heard).toEqual([])
  })

  it('keeps network, process and credential access out of the workforce code', () => {
    expect(Object.keys(sources)).toContain('./claudeRuntime.ts')
    const offenders = Object.entries(sources).flatMap(([file, text]) => FORBIDDEN.filter((re) => re.test(text)).map((re) => `${file} ${re}`))
    expect(offenders).toEqual([])
  })
})
