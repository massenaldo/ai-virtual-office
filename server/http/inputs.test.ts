import { describe, expect, it } from 'vitest'
import { parseApproval, parseCreateAgent, parseCreatePermission, parseCreateTask, parsePatchAgent } from './inputs'

describe('parseApproval', () => {
  it('accepts an optional 64-hex digest', () => {
    const digest = 'ab'.repeat(32)
    expect(parseApproval({ approvalId: 'a', decision: 'approve', digest })).toEqual({ approvalId: 'a', decision: 'approve', digest })
    expect(parseApproval({ approvalId: 'a', decision: 'deny' })).toEqual({ approvalId: 'a', decision: 'deny', digest: undefined })
  })

  it('rejects a malformed digest', () => {
    for (const digest of ['', 'xyz', 'AB'.repeat(32), 'ab'.repeat(31), 5, null]) expect(() => parseApproval({ approvalId: 'a', decision: 'approve', digest })).toThrow('"digest" must be 64 lowercase hex characters.')
  })

  it.each(['allow_once', 'allow_task', 'allow_agent', 'reject', 'approve', 'deny'])('accepts the choice %s', (decision) => {
    expect(parseApproval({ approvalId: 'a', decision })).toEqual({ approvalId: 'a', decision, digest: undefined })
  })

  it.each(['maybe', 'ALLOW_ONCE', '', 5, null])('rejects the choice %j with the full list', (decision) => {
    expect(() => parseApproval({ approvalId: 'a', decision })).toThrow('"decision" must be "allow_once", "allow_task", "allow_agent", "reject", "approve" or "deny".')
  })
})

describe('parseCreatePermission', () => {
  it('fills the optional fields with null', () => {
    expect(parseCreatePermission({ scope: 'global', effect: 'deny', tool: 'Read' })).toEqual({ scope: 'global', effect: 'deny', tool: 'Read', agentId: null, pathPattern: null, workspaceId: null, expiresAt: null, reason: null })
  })
  it('keeps a workspaceId and refuses a non-string one', () => {
    expect(parseCreatePermission({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a', workspaceId: 'sandbox' })).toMatchObject({ workspaceId: 'sandbox' })
    expect(() => parseCreatePermission({ scope: 'global', effect: 'allow', tool: 'Read', workspaceId: 5 })).toThrow('"workspaceId" must be a string or null.')
  })
  it('keeps what was sent', () => {
    expect(parseCreatePermission({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a', pathPattern: 'src/**', expiresAt: '2030-01-01T00:00:00.000Z', reason: 'ok' })).toMatchObject({ agentId: 'a', pathPattern: 'src/**', reason: 'ok' })
  })
  it.each([['task'], ['once'], [undefined], [5]])('refuses the scope %j', (scope) => {
    expect(() => parseCreatePermission({ scope, effect: 'allow', tool: 'Read' })).toThrow('"scope" must be "global" or "agent".')
  })
  it('refuses unknown keys and wrong types', () => {
    expect(() => parseCreatePermission({ scope: 'global', effect: 'allow', tool: 'Read', taskId: 't' })).toThrow('Unknown field "taskId".')
    expect(() => parseCreatePermission({ scope: 'global', effect: 'allow', tool: 'Read', reason: 5 })).toThrow('"reason" must be a string or null.')
    expect(() => parseCreatePermission({ scope: 'global', effect: 5, tool: 'Read' })).toThrow('"effect" must be a string.')
  })
})

describe('parseCreateTask runtime', () => {
  it('leaves the runtime out when none is named', () => {
    expect(parseCreateTask({ title: 'T' })).toEqual({ title: 'T', description: '', workspaceId: null })
  })
  it('accepts mock and claude', () => {
    expect(parseCreateTask({ title: 'T', runtime: 'claude' })).toMatchObject({ runtime: 'claude' })
    expect(parseCreateTask({ title: 'T', runtime: 'mock' })).toMatchObject({ runtime: 'mock' })
  })
  it.each([['Claude'], [''], ['real'], [1], [null], [true], [{}]])('refuses %j', (runtime) => {
    expect(() => parseCreateTask({ title: 'T', runtime })).toThrow('"runtime" must be "mock" or "claude".')
  })
})

describe('agent profile fields', () => {
  const base = { name: 'N', role: 'R', department: 'backend' }
  const full = { description: 'd', instructions: 'i', model: 'claude-x', takesPrayerBreaks: false }
  it('parseCreateAgent accepts the four fields and null model', () => {
    expect(parseCreateAgent({ ...base, ...full })).toEqual({ ...base, ...full })
    expect(parseCreateAgent({ ...base, model: null })).toEqual({ ...base, model: null })
    expect(parseCreateAgent(base)).toEqual(base)
  })
  it('parsePatchAgent accepts them, alone or with others', () => {
    expect(parsePatchAgent(full)).toEqual(full)
    expect(parsePatchAgent({ model: null })).toEqual({ model: null })
    expect(parsePatchAgent({ takesPrayerBreaks: true })).toEqual({ takesPrayerBreaks: true })
  })
  it('rejects sourceFile and wrong types with 400', () => {
    for (const f of [parseCreateAgent, (b: Record<string, unknown>) => parsePatchAgent(b)]) {
      expect(() => f({ ...base, sourceFile: 'a.md' })).toThrow('Unknown field "sourceFile".')
      expect(() => f({ ...base, instructions: 5 })).toThrow('"instructions" must be a string.')
      expect(() => f({ ...base, description: null })).toThrow('"description" must be a string.')
      expect(() => f({ ...base, model: 5 })).toThrow('"model" must be a string or null.')
      expect(() => f({ ...base, takesPrayerBreaks: 'yes' })).toThrow('"takesPrayerBreaks" must be a boolean.')
    }
    expect(() => parsePatchAgent({})).toThrow(/description.*instructions.*model.*takesPrayerBreaks/)
  })
})
