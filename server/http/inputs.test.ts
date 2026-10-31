import { describe, expect, it } from 'vitest'
import { parseApproval, parseCreatePermission } from './inputs'

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
    expect(parseCreatePermission({ scope: 'global', effect: 'deny', tool: 'Read' })).toEqual({ scope: 'global', effect: 'deny', tool: 'Read', agentId: null, pathPattern: null, expiresAt: null, reason: null })
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
