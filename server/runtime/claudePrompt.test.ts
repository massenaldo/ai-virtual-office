import { describe, expect, it } from 'vitest'
import { createDemoWorkforce } from '../../src/workforce/demo'
import { assignTask } from '../../src/workforce/operations'
import { buildPrompt, buildSystemPrompt } from './claudePrompt'

const demo = createDemoWorkforce('2026-11-03T09:00:00.000Z')
const taskOf = (title: string, description: string) => {
  const r = assignTask(demo, 'agent-demo-backend', { title, description }, '2026-11-03T09:00:00.000Z', { runtime: 'claude' })
  if (!r.ok) throw new Error(r.error)
  return r.state.tasks[0]
}

describe('buildPrompt', () => {
  it('is the title, then the description when there is one', () => {
    expect(buildPrompt(taskOf('Summarise', ''))).toBe('Summarise')
    expect(buildPrompt(taskOf('Summarise', 'Keep it short.'))).toBe('Summarise\n\nKeep it short.')
  })
})

describe('buildSystemPrompt', () => {
  const text = buildSystemPrompt(demo.agents.find((a) => a.id === 'agent-demo-backend')!)
  it('names the agent and its role', () => {
    expect(text).toContain('Forge')
    expect(text).toContain('API engineer')
  })
  it('says there are no tools and no files, so the model does not promise any', () => {
    expect(text).toMatch(/no tools/i)
    expect(text).toMatch(/cannot read|can't read|no access to/i)
  })
  it('does not mention a server path or a key', () => {
    expect(text).not.toMatch(/\/data|\/home|sk-ant|workspace-root/i)
  })
})
