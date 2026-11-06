import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from '../demo'
import { AGENT_INSTRUCTIONS_MAX, AGENT_DESCRIPTION_MAX } from '../types'
import AgentForm, { attemptSave, toAgentInput } from './AgentForm'

const agent = createDemoWorkforce('2026-11-03T09:00:00.000Z').agents[0]
const draft = { name: ' Nova ', role: 'Planner', department: 'design' as const, description: 'd', instructions: 'i', model: '  ', takesPrayerBreaks: true }

describe('AgentForm markup', () => {
  const create = renderToStaticMarkup(<AgentForm onSubmit={() => null} onCancel={() => {}}/>)

  it('shows the new fields with their hints', () => {
    for (const label of ['Description', 'Instructions', 'Model', 'Takes prayer breaks']) expect(create).toContain(`<span>${label}</span>`)
    expect(create).toContain('Only used on the Claude runtime. Leave empty for the server default.')
    expect(create).toContain("Describes this agent&#x27;s job. It can&#x27;t give the agent extra tools or permissions.")
    expect(create).toContain(`maxLength="${AGENT_INSTRUCTIONS_MAX}"`)
    expect(create).toContain(`maxLength="${AGENT_DESCRIPTION_MAX}"`)
    expect(create).toContain('<textarea')
  })

  it('has prayer breaks on for a new agent', () => {
    expect(create).toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
  })

  it('shows the stored values when editing', () => {
    const html = renderToStaticMarkup(<AgentForm agent={{ ...agent, description: 'Plans work', instructions: 'Be brief', model: 'claude-x', takesPrayerBreaks: false }} onSubmit={() => null} onCancel={() => {}}/>)
    expect(html).toContain('Plans work')
    expect(html).toContain('Be brief')
    expect(html).toContain('value="claude-x"')
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
  })

  it('has no source file field', () => {
    expect(create.toLowerCase()).not.toContain('sourcefile')
  })
})

describe('AgentForm submit', () => {
  it('sends the profile fields, and an empty model as null', () => {
    expect(toAgentInput(draft)).toEqual({ name: ' Nova ', role: 'Planner', department: 'design', description: 'd', instructions: 'i', model: null, takesPrayerBreaks: true })
    expect(toAgentInput({ ...draft, model: ' claude-x ' }).model).toBe('claude-x')
  })

  it('returns the server error so the form can show it', async () => {
    const onSubmit = vi.fn(async () => 'Model must be a model name.')
    expect(await attemptSave(onSubmit, draft)).toBe('Model must be a model name.')
    expect(onSubmit).toHaveBeenCalledWith(toAgentInput(draft))
    expect(await attemptSave(() => null, draft)).toBeNull()
  })
})
