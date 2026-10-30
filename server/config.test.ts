import { describe, expect, it } from 'vitest'
import { formatConfigErrors, mergeEnv, parseConfig } from './config'

const DEFAULTS = { host: '127.0.0.1', port: 8787, dataDir: '/repo/data', runtime: 'mock', taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144, eventBufferSize: 500, credentialsConfigured: false }
const NAMES = ['HOST', 'PORT', 'DATA_DIR', 'RUNTIME', 'TASK_TIMEOUT_MS', 'CANCEL_GRACE_MS', 'APPROVAL_TIMEOUT_MS', 'MAX_MESSAGE_BYTES', 'MAX_TASK_OUTPUT_BYTES', 'EVENT_BUFFER_SIZE', 'ANTHROPIC_API_KEY']

describe('parseConfig', () => {
  it('uses the defaults for an empty environment', () => {
    expect(parseConfig({}, '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('treats empty strings as unset', () => {
    expect(parseConfig(Object.fromEntries(NAMES.map((n) => [n, ''])), '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('reads every variable', () => {
    const r = parseConfig({ HOST: 'localhost', PORT: '9000', DATA_DIR: 'tmp/x', RUNTIME: 'claude', TASK_TIMEOUT_MS: '1000', CANCEL_GRACE_MS: '200', APPROVAL_TIMEOUT_MS: '3000', MAX_MESSAGE_BYTES: '100', MAX_TASK_OUTPUT_BYTES: '1000', EVENT_BUFFER_SIZE: '20', ANTHROPIC_API_KEY: 'k' }, '/repo')
    expect(r).toEqual({ ok: true, config: { host: 'localhost', port: 9000, dataDir: '/repo/tmp/x', runtime: 'claude', taskTimeoutMs: 1000, cancelGraceMs: 200, approvalTimeoutMs: 3000, maxMessageBytes: 100, maxTaskOutputBytes: 1000, eventBufferSize: 20, credentialsConfigured: true } })
  })

  it('collects every error with readable copy', () => {
    expect(parseConfig({ PORT: 'abc', RUNTIME: 'gpt', TASK_TIMEOUT_MS: '0' }, '/repo')).toEqual({
      ok: false,
      errors: ['PORT must be an integer from 0 to 65535 (got "abc").', 'RUNTIME must be "mock" or "claude" (got "gpt").', 'TASK_TIMEOUT_MS must be a positive integer (got "0").'],
    })
  })

  it('refuses a non-loopback HOST', () => {
    expect(parseConfig({ HOST: '0.0.0.0' }, '/repo')).toEqual({ ok: false, errors: ['HOST must be a loopback address (127.0.0.1, ::1 or localhost) until origin checks are added (got "0.0.0.0").'] })
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
