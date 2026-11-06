import { describe, expect, it } from 'vitest'
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from '../../src/workforce/types'
import { NAME_MAX, ROLE_MAX } from '../../src/workforce/operations'
import { parseAgentFile, suggestedRole } from './parse'

const file = (front: string, body = 'Do the work.') => `---\n${front}\n---\n${body}\n`
const ok = (text: string) => {
  const r = parseAgentFile(text)
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.agent
}
const bad = (text: string) => {
  const r = parseAgentFile(text)
  if (r.ok) throw new Error('expected an error')
  return r.error
}

describe('parseAgentFile', () => {
  it('reads plain, single and double quoted values', () => {
    expect(ok(file('name: Forge\ndescription: d')).name).toBe('Forge')
    expect(ok(file("name: 'Forge'\ndescription: d")).name).toBe('Forge')
    expect(ok(file('name: "Forge"\ndescription: d')).name).toBe('Forge')
  })
  it('takes the body as instructions', () => {
    expect(ok(file('name: Forge', 'Line one.\nLine two.')).instructions).toBe('Line one.\nLine two.')
  })
  it('folds and keeps block scalars', () => {
    expect(ok(file('name: Forge\ndescription: >\n  one\n  two')).description).toBe('one two')
    expect(ok(file('name: Forge\ndescription: |\n  one\n  two')).description).toBe('one\ntwo')
  })
  it('handles a byte order mark and CRLF', () => {
    const lf = ok(file('name: Forge\ndescription: >\n  a\n  b', 'x\ny'))
    const crlf = ok('﻿' + file('name: Forge\ndescription: >\n  a\n  b', 'x\ny').replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(lf)
    expect(JSON.stringify(crlf)).not.toContain('\\r')
  })
  it('lists ignored fields by key name only', () => {
    const a = ok(file('name: Forge\ntools: [Bash]\npermissionMode: bypassPermissions\nhooks:\n  name: Evil\n  model: x y\n  tools: z'))
    expect(a.ignoredFields).toEqual(['tools', 'permissionMode', 'hooks'])
    expect(a.name).toBe('Forge')
    expect(a.model).toBeNull()
    expect(JSON.stringify(a)).not.toContain('bypassPermissions')
  })
  it('maps model', () => {
    expect(ok(file('name: F\nmodel: inherit')).model).toBeNull()
    expect(ok(file('name: F\nmodel: sonnet')).model).toBe('sonnet')
    expect(ok(file('name: F')).model).toBeNull()
    expect(bad(file('name: F\nmodel: no good!'))).toMatch(/model/i)
  })
  it('cuts a long description', () => {
    const a = ok(file(`name: F\ndescription: ${'x'.repeat(AGENT_DESCRIPTION_MAX + 20)}`))
    expect(a.description).toHaveLength(AGENT_DESCRIPTION_MAX)
    expect(a.descriptionCut).toBe(true)
    expect(ok(file('name: F\ndescription: short')).descriptionCut).toBe(false)
  })
  it('refuses malformed files with a sentence', () => {
    expect(bad('name: F\n')).toMatch(/\.$/)
    expect(bad('---\nname: F\nbody')).toMatch(/\.$/)
    expect(bad(file('description: d'))).toMatch(/name/i)
    expect(bad(file('name:   '))).toMatch(/name/i)
    expect(bad(file(`name: ${'x'.repeat(NAME_MAX + 1)}`))).toMatch(/name/i)
    expect(bad(file('name: A\nname: B'))).toMatch(/twice|more than once/i)
    expect(bad(file('name: F', 'x'.repeat(AGENT_INSTRUCTIONS_MAX + 1)))).toMatch(/instructions/i)
  })
  it('refuses unsafe characters in values and body', () => {
    expect(bad(file('name: F\u0007x'))).toMatch(/character/i)
    expect(bad(file('name: F\ndescription: a‮b'))).toMatch(/character/i)
    expect(bad(file('name: F', 'a\u0000b'))).toMatch(/character/i)
    expect(bad(file('name: F', 'a​b'))).toMatch(/character/i)
  })
  it('masks secrets', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(40)
    const a = ok(file(`name: F\ndescription: key ${secret}`, `token ${secret}`))
    expect(a.description).toContain('[REDACTED]')
    expect(a.instructions).toContain('[REDACTED]')
    expect(a.description + a.instructions).not.toContain(secret)
    expect(a.secretsMasked).toBe(true)
    expect(ok(file('name: F')).secretsMasked).toBe(false)
  })
})

describe('suggestedRole', () => {
  it('makes a sentence from the file name', () => {
    expect(suggestedRole('backend-engineer.md')).toBe('Backend engineer')
    expect(suggestedRole('qa_lead.md')).toBe('Qa lead')
    expect(suggestedRole(`${'a'.repeat(200)}.md`)).toHaveLength(ROLE_MAX)
  })
})
