import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CONFIG_VARIABLES, formatConfigErrors, mergeEnv, parseConfig } from './config'

const DEFAULTS = { host: '127.0.0.1', port: 8787, dataDir: '/repo/data', runtime: 'mock', taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144, eventBufferSize: 500, auditLogMaxBytes: 5242880, credentialsConfigured: false }
const NAMES = CONFIG_VARIABLES

describe('parseConfig', () => {
  it('uses the defaults for an empty environment', () => {
    expect(parseConfig({}, '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('treats empty strings as unset', () => {
    expect(parseConfig(Object.fromEntries(NAMES.map((n) => [n, ''])), '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('reads every variable', () => {
    const r = parseConfig({ HOST: 'localhost', PORT: '9000', DATA_DIR: 'tmp/x', RUNTIME: 'claude', TASK_TIMEOUT_MS: '1000', CANCEL_GRACE_MS: '200', APPROVAL_TIMEOUT_MS: '3000', MAX_MESSAGE_BYTES: '100', MAX_TASK_OUTPUT_BYTES: '1000', EVENT_BUFFER_SIZE: '20', AUDIT_LOG_MAX_BYTES: '65536', ANTHROPIC_API_KEY: 'k' }, '/repo')
    expect(r).toEqual({ ok: true, config: { host: 'localhost', port: 9000, dataDir: '/repo/tmp/x', runtime: 'claude', taskTimeoutMs: 1000, cancelGraceMs: 200, approvalTimeoutMs: 3000, maxMessageBytes: 100, maxTaskOutputBytes: 1000, eventBufferSize: 20, auditLogMaxBytes: 65536, credentialsConfigured: true } })
  })

  it('collects every error with readable copy', () => {
    expect(parseConfig({ PORT: 'abc', RUNTIME: 'gpt', TASK_TIMEOUT_MS: '0' }, '/repo')).toEqual({
      ok: false,
      errors: ['PORT must be an integer from 0 to 65535 (got "abc").', 'RUNTIME must be "mock" or "claude" (got "gpt").', 'TASK_TIMEOUT_MS must be a positive integer (got "0").'],
    })
  })

  it('refuses a non-loopback HOST', () => {
    expect(parseConfig({ HOST: '0.0.0.0' }, '/repo')).toEqual({ ok: false, errors: ['HOST must be a loopback address (127.0.0.1, ::1 or localhost) (got "0.0.0.0"). Remote access needs TLS and authentication, which this server does not have yet.'] })
    expect(parseConfig({ HOST: 'localhost' }, '/repo').ok).toBe(true)
    expect(parseConfig({ HOST: '::1' }, '/repo').ok).toBe(true)
  })

  it('rejects a message cap larger than the task cap', () => {
    expect(parseConfig({ MAX_MESSAGE_BYTES: '2000', MAX_TASK_OUTPUT_BYTES: '1000' }, '/repo')).toEqual({ ok: false, errors: ['MAX_MESSAGE_BYTES must not exceed MAX_TASK_OUTPUT_BYTES.'] })
  })

  it('rejects out-of-range and fractional numbers', () => {
    expect(parseConfig({ PORT: '70000' }, '/repo').ok).toBe(false)
    expect(parseConfig({ PORT: '1.5' }, '/repo').ok).toBe(false)
    expect(parseConfig({ CANCEL_GRACE_MS: '-1' }, '/repo').ok).toBe(false)
    expect(parseConfig({ PORT: '0' }, '/repo').ok).toBe(true)
  })

  it('rejects a timer longer than Node can schedule', () => {
    const max = 2147483647
    for (const name of ['TASK_TIMEOUT_MS', 'CANCEL_GRACE_MS', 'APPROVAL_TIMEOUT_MS']) {
      expect(parseConfig({ [name]: String(max) }, '/repo').ok).toBe(true)
      expect(parseConfig({ [name]: String(max + 1) }, '/repo')).toEqual({ ok: false, errors: [`${name} must be at most 2147483647 ms, about 24 days (got "${max + 1}").`] })
    }
    expect(parseConfig({ TASK_TIMEOUT_MS: '9'.repeat(400) }, '/repo').ok).toBe(false)
  })

  it('keeps only a flag for the API key', () => {
    const r = parseConfig({ ANTHROPIC_API_KEY: 'sk-test-123' }, '/repo')
    expect(r.ok && r.config.credentialsConfigured).toBe(true)
    expect(JSON.stringify(r)).not.toContain('sk-test-123')
    expect(parseConfig({ ANTHROPIC_API_KEY: '   ' }, '/repo')).toMatchObject({ config: { credentialsConfigured: false } })
  })
})

describe('mergeEnv', () => {
  it('lets the real environment win', () => {
    expect(mergeEnv('PORT=9000\nHOST=localhost', { PORT: '8000' })).toMatchObject({ PORT: '8000', HOST: 'localhost' })
    const env = { A: '1' }
    const copy = mergeEnv(null, env)
    expect(copy).toEqual(env)
    expect(copy).not.toBe(env)
  })
})

describe('formatConfigErrors', () => {
  it('lists every error', () => {
    expect(formatConfigErrors(['A', 'B'])).toBe('Server config is invalid:\n- A\n- B')
  })
})

describe('security-related config', () => {
  it('reads AUDIT_LOG_MAX_BYTES and enforces its range', () => {
    const copy = (v: string) => `AUDIT_LOG_MAX_BYTES must be from 65536 to 1073741824 (got "${v}").`
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '1000' }, '/repo')).toEqual({ ok: false, errors: [copy('1000')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: 'abc' }, '/repo')).toEqual({ ok: false, errors: [copy('abc')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '2000000000' }, '/repo')).toEqual({ ok: false, errors: [copy('2000000000')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '65536' }, '/repo')).toMatchObject({ ok: true, config: { auditLogMaxBytes: 65536 } })
  })

  it('refuses permission-bypass variables', () => {
    const r = parseConfig({ DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_PERMISSION_MODE: 'x', BYPASS_PERMISSIONS: '' }, '/repo')
    expect(r).toEqual({
      ok: false,
      errors: [
        'DANGEROUSLY_SKIP_PERMISSIONS is not supported: this server has no way to skip permission checks. Remove it.',
        'CLAUDE_PERMISSION_MODE is not supported: this server has no way to skip permission checks. Remove it.',
        'BYPASS_PERMISSIONS is not supported: this server has no way to skip permission checks. Remove it.',
      ],
    })
  })

  it('no config variable suggests a bypass', () => {
    expect(CONFIG_VARIABLES.filter((n) => /bypass|danger|skip|unsafe|yolo|permission/i.test(n))).toEqual([])
  })

  it('.env.example lists exactly the config variables', () => {
    const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    const names = new Set(text.split('\n').flatMap((l) => (/^([A-Z0-9_]+)=/.exec(l) ? [/^([A-Z0-9_]+)=/.exec(l)![1]] : [])))
    expect(names).toEqual(new Set([...CONFIG_VARIABLES, 'VITE_WORKFORCE_API_URL']))
  })
})

