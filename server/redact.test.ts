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

describe('redactSecrets: JWT, Slack, Google, PEM, -p and URL passwords', () => {
  // Built from pieces so no literal in the source looks like a real token to secret scanners (GitHub push protection).
  const SLACK_BOT = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')
  const SLACK_USER = ['xoxp', '123456789012', '123456789012', '123456789012', 'abcdef0123456789abcdef0123456789'].join('-')
  const SLACK_APP = ['xapp', '1', 'A0123456789', '1234567890123', 'abcdef0123456789abcdef'].join('-')
  const GOOGLE = ['AIza', 'SyA-1234567890abcdefghijklmnopqrstu'].join('')
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  const BODY = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u'
  const pem = (label: string, end = true) => `-----BEGIN ${label}-----\n${BODY}\n${BODY}\n${end ? `-----END ${label}-----` : ''}`

  it.each([
    [`token ${JWT} end`, 'token [REDACTED] end'],
    [`Authorization: Bearer ${JWT}`, 'Authorization: Bearer [REDACTED]'],
    [`bot ${SLACK_BOT} ok`, 'bot [REDACTED] ok'],
    [`user ${SLACK_USER} ok`, 'user [REDACTED] ok'],
    [`app ${SLACK_APP} ok`, 'app [REDACTED] ok'],
    [`key ${GOOGLE} here`, 'key [REDACTED] here'],
    ['mysql -uroot -pS3cret db', 'mysql -uroot -p[REDACTED] db'],
    ["sshpass -p 'x y' ssh h", 'sshpass -p [REDACTED] ssh h'],
    ['sshpass -p hunter2 ssh h', 'sshpass -p [REDACTED] ssh h'],
    ['https://u:p@ss@host/x', 'https://[REDACTED]@host/x'],
    ['postgres://u:pa/ss@db:5432/app', 'postgres://[REDACTED]@db:5432/app'],
    ['redis://:p@ss@host:6379', 'redis://[REDACTED]@host:6379'],
    [`before\n${pem('RSA PRIVATE KEY')}\nafter`, 'before\n[REDACTED]\nafter'],
    [`a ${pem('EC PRIVATE KEY')} b`, 'a [REDACTED] b'],
    [pem('OPENSSH PRIVATE KEY'), '[REDACTED]'],
    [pem('ENCRYPTED PRIVATE KEY'), '[REDACTED]'],
    [pem('PRIVATE KEY'), '[REDACTED]'],
    [`start ${pem('RSA PRIVATE KEY', false)}`, 'start [REDACTED]'],
    [`${pem('RSA PRIVATE KEY')}\n${pem('EC PRIVATE KEY')}`, '[REDACTED]\n[REDACTED]'],
  ])('redacts: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('redacts a private key block that scrub cuts short', () => {
    const cut = scrub(`log ${pem('RSA PRIVATE KEY')}`, 100)
    expect(cut).not.toContain('MIIE')
    expect(cut).toContain('[REDACTED]')
  })

  it.each([
    'eyJ alone and a.b two parts, eyJhbGciOiJIUzI1NiJ9 header only',
    'xox in prose, xoxb is a prefix, xapp-1 too',
    `key AIza${'a'.repeat(34)} is one character short`,
    '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----',
    '-----BEGIN PUBLIC KEY-----\nMFww\n-----END PUBLIC KEY-----',
    'ssh -p 22 host',
    'mkdir -p a/b',
    'docker run -p 8080:80 nginx',
    'cp -p a b',
    'pg_dump -p 5432 db',
    'find . -print -prune',
    'mysql -uroot -p5432 db',
    'mysql -uroot -p db',
    'https://host:8080/a/@scope/pkg',
    'http://localhost:5173/@vite/client',
    'https://example.com/@user',
    'ssh://git@host',
    'sshpass is a tool; ssh -p 22 host',
  ])('leaves alone: %s', (input) => {
    expect(redactSecrets(input)).toBe(input)
  })

  it('stays fast on hostile input', () => {
    const slow: Array<[string, string]> = [
      ['unterminated key lines', '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(3125)],
      ['url start without @', `https://a:${'x'.repeat(100000)}`],
      ['jwt-like repeats', 'eyJ.'.repeat(25000)],
      ['xox repeats', 'xox-'.repeat(25000)],
      ['many urls', 'https://a:b '.repeat(8000)],
    ]
    for (const [name, text] of slow) {
      const t0 = performance.now()
      redactSecrets(text)
      expect(performance.now() - t0, name).toBeLessThan(50)
    }
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

