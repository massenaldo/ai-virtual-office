import { describe, expect, it } from 'vitest'
import { recordingLogger } from './log'
import { findSecretInConfig, redactingLogger, redactSecrets, scrub } from './redact'

describe('redactSecrets', () => {
  it.each([
    ['key sk-ant-api03-abcdefghijklmnop end', 'key [REDACTED] end'],
    ['Authorization: Bearer abc.def-123456', 'Authorization: Bearer [REDACTED]'],
    ['api_key=xyz123&x=1', 'api_key=[REDACTED]&x=1'],
    ['password: "hunter2"', 'password: [REDACTED]'],
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijkl', 'ANTHROPIC_API_KEY=[REDACTED]'],
    ['{"apiKey":"abc"}', '{"apiKey":[REDACTED]}'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz', '[REDACTED]'],
  ])('redacts known secret shapes: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Build the REST API')).toBe('Build the REST API')
    expect(redactSecrets('no secrets here')).toBe('no secrets here')
  })
})

describe('scrub', () => {
  it('truncates after redacting', () => {
    const long = scrub('a'.repeat(600))
    expect(long).toHaveLength(512)
    expect(long.endsWith('…')).toBe(true)
    expect(scrub('x sk-ant-api03-abcdefghijk', 10)).toBe('x [REDACT…')
  })
})

describe('redactingLogger', () => {
  it('redacts messages and errors', () => {
    const inner = recordingLogger()
    redactingLogger(inner).error('failed sk-ant-api03-abcdefghijk', new Error('Bearer abcdefghijkl'))
    expect(inner.lines[0].startsWith('error failed [REDACTED]')).toBe(true)
    expect(inner.lines[0]).toContain('Bearer [REDACTED]')
    expect(inner.lines[0]).not.toContain('abcdefghijk')
  })

  it('passes info and warn through redacted', () => {
    const inner = recordingLogger()
    const log = redactingLogger(inner)
    log.info('token=abcdef123456')
    log.warn('ok')
    expect(inner.lines).toEqual(['info token=[REDACTED]', 'warn ok'])
  })
})

describe('findSecretInConfig', () => {
  it('finds a secret value inside a config object', () => {
    expect(findSecretInConfig({ a: 'x sk-ant-test-canary' }, 'sk-ant-test-canary')).not.toBeNull()
    expect(findSecretInConfig({ a: 1 }, 'sk-ant-test-canary')).toBeNull()
    expect(findSecretInConfig({ a: 'short' }, 'short')).toBeNull()
    expect(findSecretInConfig({ a: 'x' }, undefined)).toBeNull()
  })
})

describe('redactSecrets cost', () => {
  it('stays fast on long runs of secret-looking words', () => {
    const t0 = Date.now()
    redactSecrets('token'.repeat(50000))
    redactSecrets('key '.repeat(60000))
    redactSecrets('a'.repeat(300000) + 'password=x')
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('still redacts a long key name', () => {
    expect(redactSecrets(`${'a'.repeat(30)}_api_key=abc123456`)).toBe(`${'a'.repeat(30)}_api_key=[REDACTED]`)
  })
})

