import { describe, expect, it } from 'vitest'
import { readPublicConfig } from './publicConfig'

const PW = 'twelve-chars'
const ok = (env: Record<string, string | undefined>) => {
  const r = readPublicConfig(env)
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r
}
const errors = (env: Record<string, string | undefined>) => {
  const r = readPublicConfig(env)
  return r.ok ? [] : r.errors
}

describe('readPublicConfig', () => {
  it('uses the defaults', () => {
    expect(ok({ VO_PASSWORD: PW })).toEqual({ ok: true, host: '0.0.0.0', port: 3000, password: PW, allowClaude: false })
  })
  it('treats empty values as unset', () => {
    expect(ok({ VO_PASSWORD: PW, PUBLIC_HOST: '', PUBLIC_PORT: '', RUNTIME: '' })).toMatchObject({ host: '0.0.0.0', port: 3000 })
  })
  it('requires the password', () => {
    const msg = 'VO_PASSWORD is required. Set it to a password of at least 12 characters.'
    expect(errors({})).toEqual([msg])
    expect(errors({ VO_PASSWORD: '' })).toEqual([msg])
  })
  it('accepts 12 characters and refuses 11', () => {
    expect(ok({ VO_PASSWORD: '123456789012' }).password).toBe('123456789012')
    expect(errors({ VO_PASSWORD: '12345678901' })).toEqual(['VO_PASSWORD must be at least 12 characters.'])
  })
  it('does not trim the password', () => {
    expect(ok({ VO_PASSWORD: ' 1234567890 ' }).password).toBe(' 1234567890 ')
    expect(errors({ VO_PASSWORD: ' '.repeat(12) })).toEqual([])
  })
  it('trims host and port', () => {
    expect(ok({ VO_PASSWORD: PW, PUBLIC_HOST: ' 127.0.0.1 ', PUBLIC_PORT: ' 4000 ' })).toMatchObject({ host: '127.0.0.1', port: 4000 })
  })
  it('validates the port', () => {
    for (const bad of ['0', '65536', '30.5', 'abc', '-1', '1e3']) {
      expect(errors({ VO_PASSWORD: PW, PUBLIC_PORT: bad })).toEqual([`PUBLIC_PORT must be an integer from 1 to 65535 (got "${bad}").`])
    }
    expect(ok({ VO_PASSWORD: PW, PUBLIC_PORT: '65535' }).port).toBe(65535)
  })
  it('validates the host', () => {
    expect(errors({ VO_PASSWORD: PW, PUBLIC_HOST: 'a b' })).toEqual(['PUBLIC_HOST must be a host name or address with no spaces.'])
  })
  it('refuses RUNTIME=claude unless allowed', () => {
    const msg = 'RUNTIME=claude is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-3-report.md are met.'
    expect(errors({ VO_PASSWORD: PW, RUNTIME: 'claude' })).toEqual([msg])
    expect(errors({ VO_PASSWORD: PW, RUNTIME: 'claude', VO_ALLOW_PUBLIC_CLAUDE: 'no' })).toEqual([msg])
    expect(ok({ VO_PASSWORD: PW, RUNTIME: 'claude', VO_ALLOW_PUBLIC_CLAUDE: 'yes' }).allowClaude).toBe(true)
    expect(ok({ VO_PASSWORD: PW, RUNTIME: 'mock' }).allowClaude).toBe(false)
  })
  it('refuses ENABLE_CLAUDE_RUNTIME=yes unless allowed, with its own sentence', () => {
    const msg = 'ENABLE_CLAUDE_RUNTIME=yes is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-prerequisites.md are met.'
    expect(errors({ VO_PASSWORD: PW, ENABLE_CLAUDE_RUNTIME: 'yes' })).toEqual([msg])
    expect(errors({ VO_PASSWORD: PW, ENABLE_CLAUDE_RUNTIME: ' yes ' })).toEqual([msg])
    expect(errors({ VO_PASSWORD: PW, ENABLE_CLAUDE_RUNTIME: 'yes', VO_ALLOW_PUBLIC_CLAUDE: 'no' })).toEqual([msg])
    expect(ok({ VO_PASSWORD: PW, ENABLE_CLAUDE_RUNTIME: 'yes', VO_ALLOW_PUBLIC_CLAUDE: 'yes' }).allowClaude).toBe(true)
    for (const v of ['', 'no', 'YES', 'true', '1']) expect(errors({ VO_PASSWORD: PW, ENABLE_CLAUDE_RUNTIME: v })).toEqual([])
  })
  it('names both settings when both are set', () => {
    expect(errors({ VO_PASSWORD: PW, RUNTIME: 'claude', ENABLE_CLAUDE_RUNTIME: 'yes' })).toHaveLength(2)
  })
  it('reports every error at once', () => {
    expect(errors({ VO_PASSWORD: 'short', PUBLIC_PORT: 'x', PUBLIC_HOST: 'a b', RUNTIME: 'claude' })).toHaveLength(4)
  })
})
