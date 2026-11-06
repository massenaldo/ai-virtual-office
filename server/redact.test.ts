import { describe, expect, it } from 'vitest'
import { recordingLogger } from './log'
import { findSecretInConfig, redactingLogger, redactSecrets, scrub } from './redact'
import { measureScaling } from './test/scaling'

/** Hostile inputs, sized so the smaller run takes a few milliseconds. Cost must grow about linearly with the size, never faster. */
const expectLinear = (name: string, make: (n: number) => string, small: number) => {
  const r = measureScaling(make, redactSecrets, { small })
  expect(r.ratio, `${name}: ${r.smallMs.toFixed(1)} ms then ${r.largeMs.toFixed(1)} ms for 8x the input (n=${r.n})`).toBeLessThan(r.limit)
}

// Each scaling test times several inputs, each run 5 times at two sizes: together 1.5 to 6 s of CPU on a quiet machine,
// which is over vitest's 5 s default when the machine is loaded. This is a bound on total test time, not on any one case:
// expectLinear still fails on the ratio alone.
const SCALING_TIMEOUT_MS = 60_000

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

  it('costs about linear time on long near-matches', () => {
    expectLinear('url start', (n) => `https://${'a'.repeat(n)}`, 200000)
    expectLinear('basic', (n) => `Basic ${'A'.repeat(n)}`, 200000)
    expectLinear('password flags', (n) => '--password '.repeat(n), 5000)
    expectLinear('ghp', (n) => `ghp_${'a'.repeat(n)}`, 200000)
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

  it('redacts every credential URL in a text with no spaces, not only the first', () => {
    expect(redactSecrets('{"a":"https://x.com/","b":"postgres://admin:hunter2@db:5432/app"}')).toBe('{"a":"https://x.com/","b":"postgres://[REDACTED]@db:5432/app"}')
    expect(redactSecrets('see https://a.com,ftp://u:secretpw@h/x')).toBe('see https://a.com,ftp://[REDACTED]@h/x')
    expect(redactSecrets('https://u:p1@h1/x;redis://:p2@h2;ssh://git@h3')).toBe('https://[REDACTED]@h1/x;redis://[REDACTED]@h2;ssh://git@h3')
  })

  it('finds a JWT anywhere in a run of text and costs about linear time on hostile input', () => {
    expect(redactSecrets(`x=${JWT}&y=1`)).toContain('[REDACTED]')
    expect(redactSecrets(`a${JWT}`)).toContain(JWT.slice(0, 20))
    expectLinear('eyJ-', (n) => 'eyJ-'.repeat(n), 25000)
    expectLinear('eyJ', (n) => 'eyJ'.repeat(n), 25000)
    expectLinear('eyJ then a run', (n) => `eyJ${'a'.repeat(n)}`, 200000)
    expectLinear('header-like repeats', (n) => 'eyJaaaaaaaaaaaa.'.repeat(n), 8000)
  }, SCALING_TIMEOUT_MS)

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

  it.each([
    ['sk_live_' + 'a1B2c3D4e5F6g7H8i9', '[REDACTED]'],
    ['pay rk_test_' + 'a1B2c3D4e5F6g7H8 done', 'pay [REDACTED] done'],
    ['sk_test_' + 'A'.repeat(24), '[REDACTED]'],
    ['rk_live_' + 'z9'.repeat(10), '[REDACTED]'],
    ['token glpat-' + 'abcdEFGH_1234-ijklMNOP', 'token [REDACTED]'],
    ['x npm_' + 'aB3'.repeat(12) + ' y', 'x [REDACTED] y'],
    ['xoxe-1-' + 'abcdefghij1234567890', '[REDACTED]'],
    ['xoxe.xoxp-1-' + 'abcdefghij1234567890', '[REDACTED]'],
    ['AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'aws_secret_access_key = [REDACTED]'],
    ['aws_secret_access_key: "' + 'wJalrXUtnFEMI/K7MDENG"', 'aws_secret_access_key: [REDACTED]'],
  ])('redacts more secret formats: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it.each([
    'sk_live_stream', 'sk_test_ok', 'rk_live_short1234567', 'npm_config', 'npm_' + 'a'.repeat(20), 'glpat-short', 'xoxe is a word', 'use the sk_live_ prefix',
  ])('leaves alone: %s', (input) => {
    expect(redactSecrets(input)).toBe(input)
  })

  it('costs about linear time on hostile input', () => {
    expectLinear('unterminated key lines', (n) => '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(n), 800)
    expectLinear('url start without @', (n) => `https://a:${'x'.repeat(n)}`, 200000)
    expectLinear('jwt-like repeats', (n) => 'eyJ.'.repeat(n), 6000)
    expectLinear('xox repeats', (n) => 'xox-'.repeat(n), 6000)
    expectLinear('many urls', (n) => 'https://a:b '.repeat(n), 2000)
  })

  it('costs about linear time on the token formats', () => {
    expectLinear('stripe run', (n) => `sk_live_${'a'.repeat(n)}`, 200000)
    expectLinear('stripe prefixes', (n) => 'sk_live_a'.repeat(n), 20000)
    expectLinear('glpat run', (n) => `glpat-${'a'.repeat(n)}`, 200000)
    expectLinear('glpat prefixes', (n) => 'glpat-a'.repeat(n), 20000)
    expectLinear('npm run', (n) => `npm_${'a'.repeat(n)}`, 200000)
    expectLinear('npm prefixes', (n) => 'npm_aaaa'.repeat(n), 20000)
    expectLinear('xoxe run', (n) => `xoxe.xoxp-${'a-'.repeat(n)}`, 100000)
    expectLinear('xoxe prefixes', (n) => 'xoxe.xoxp-'.repeat(n), 10000)
    expectLinear('aws assignments', (n) => 'aws_secret_access_key = '.repeat(n), 5000)
    expectLinear('aws long space', (n) => `aws_secret_access_key${' '.repeat(n)}`, 100000)
  }, SCALING_TIMEOUT_MS)
})

describe('PGP and PuTTY private keys', () => {
  const B = 'lQdGBF8bodybodybodybodybodybodybody1234567890abcdef'
  const pgp = (end = true) => `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${B}\n${B}\n${end ? '-----END PGP PRIVATE KEY BLOCK-----' : ''}`
  const ppk = (mac = true) => `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: deploy\nPublic-Lines: 2\nAAAApublicpart\nPrivate-Lines: 1\nAAAAprivatepart${mac ? '\nPrivate-MAC: 0123abcd' : ''}`
  it('redacts a PGP private key block and keeps the text around it', () => {
    expect(redactSecrets(`before\n${pgp()}\nafter`)).toBe('before\n[REDACTED]\nafter')
    expect(redactSecrets(`a ${pgp(false)}`)).toBe('a [REDACTED]')
  })
  it('keeps a PGP public key block', () => {
    const pub = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${B}\n-----END PGP PUBLIC KEY BLOCK-----`
    expect(redactSecrets(pub)).toBe(pub)
  })
  it('redacts a PuTTY key file from its header through the Private-MAC line', () => {
    const out = redactSecrets(`top\n${ppk()}\nbottom`)
    expect(out).toBe('top\n[REDACTED]\nbottom')
    expect(out).not.toContain('privatepart')
  })
  it('redacts a PuTTY key file with no MAC line to the end, and with CRLF', () => {
    expect(redactSecrets(`x ${ppk(false)}`)).toBe('x [REDACTED]')
    expect(redactSecrets(ppk().replace(/\n/g, '\r\n') + '\r\nafter')).toBe('[REDACTED]\nafter'.replace('\n', '\r\n'))
  })
  it('costs about linear time on repeated starts', () => {
    expectLinear('pgp starts', (n) => '-----BEGIN PGP PRIVATE KEY BLOCK-----\n'.repeat(n), 800)
    expectLinear('putty starts', (n) => 'PuTTY-User-Key-File-3: x\n'.repeat(n), 800)
    expectLinear('pgp near misses', (n) => '-----BEGIN PGP PUBLIC KEY BLOCK-----\n'.repeat(n), 800)
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
  it('costs about linear time on long runs of secret-looking words', () => {
    expectLinear('token', (n) => 'token'.repeat(n), 50000)
    expectLinear('key', (n) => 'key '.repeat(n), 60000)
    expectLinear('long name before a match', (n) => 'a'.repeat(n) + 'password=x', 300000)
  })

  it('still redacts a long key name', () => {
    expect(redactSecrets(`${'a'.repeat(30)}_api_key=abc123456`)).toBe(`${'a'.repeat(30)}_api_key=[REDACTED]`)
  })
})

