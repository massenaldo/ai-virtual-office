import { describe, expect, it } from 'vitest'
import { parseApproval } from './inputs'

describe('parseApproval', () => {
  it('accepts an optional 64-hex digest', () => {
    const digest = 'ab'.repeat(32)
    expect(parseApproval({ approvalId: 'a', decision: 'approve', digest })).toEqual({ approvalId: 'a', decision: 'approve', digest })
    expect(parseApproval({ approvalId: 'a', decision: 'deny' })).toEqual({ approvalId: 'a', decision: 'deny', digest: undefined })
  })

  it('rejects a malformed digest', () => {
    for (const digest of ['', 'xyz', 'AB'.repeat(32), 'ab'.repeat(31), 5, null]) expect(() => parseApproval({ approvalId: 'a', decision: 'approve', digest })).toThrow('"digest" must be 64 lowercase hex characters.')
  })
})
