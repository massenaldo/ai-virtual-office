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

describe('redactSecrets: more secret shapes', () => {
  const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  const B64 = Buffer.from('alice:s3cret').toString('base64')
  it.each([
    ['git clone https://alice:s3cret@example.com/repo.git', 'git clone https://[REDACTED]@example.com/repo.git'],
    ['postgres://admin:pw%40x@db.local:5432/app', 'postgres://[REDACTED]@db.local:5432/app'],
    [`token ${GH} used`, 'token [REDACTED] used'],
    [`github_pat_${'A1b2C3d4E5f6G7h8I9j0K1'}_more`, '[REDACTED]'],
    ['id AKIAIOSFODNN7EXAMPLE here', 'id [REDACTED] here'],
    ['id ASIAIOSFODNN7EXAMPLE here', 'id [REDACTED] here'],
    [`Authorization: Basic ${B64}`, 'Authorization: Basic [REDACTED]'],
    ['mysql --password hunter2 -u root', 'mysql --password [REDACTED] -u root'],
    ['mysql --password=hunter2 -u root', 'mysql --password=[REDACTED] -u root'],
    ["tool --api-key 'abc def' run", 'tool --api-key [REDACTED] run'],
    ['tool --passwd=x --secret y', 'tool --passwd=[REDACTED] --secret [REDACTED]'],
    ['curl -u admin:pw https://x.test', 'curl -u [REDACTED] https://x.test'],
    ['curl --user admin:pw https://x.test', 'curl --user [REDACTED] https://x.test'],
    ['Authorization: Basic dXNlcjpwYXM', 'Authorization: Basic [REDACTED]'],
  ])('redacts: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it.each([
    'see https://example.com/@user for the profile',
    'ssh://git@github.com/org/repo.git',
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'AKIA is a prefix, AKIA123 is too short, and XAKIAIOSFODNN7EXAMPLEX is inside a word',
    'Basic configuration of the server',
    'Basic usage: run it',
    'curl -u admin https://x.test',
    'use -u for unbuffered output',
    'mysql --password-file ./secrets.txt',
    'open password_reset.md and ghp_short',
    'ghp_ is the prefix GitHub uses',
  ])('leaves alone: %s', (input) => {
    expect(redactSecrets(input)).toBe(input)
  })

  it('stays fast on long near-matches', () => {
    const t0 = Date.now()
    redactSecrets(`https://${'a'.repeat(50000)}`)
    redactSecrets(`Basic ${'A'.repeat(50000)}`)
    redactSecrets('--password '.repeat(20000))
    redactSecrets(`ghp_${'a'.repeat(50000)}`)
    expect(Date.now() - t0).toBeLessThan(500)
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

