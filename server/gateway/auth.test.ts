import { describe, expect, it } from 'vitest'
import { createPasswordCheck } from './auth'

const PASSWORD = 'correct-horse-battery'
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`

function setup(extra: { failureLimit?: number; windowMs?: number; lockoutMs?: number } = {}) {
  let t = 1_000_000
  const check = createPasswordCheck({ password: PASSWORD, now: () => t, ...extra })
  return { check: check.check, advance: (ms: number) => { t += ms } }
}

describe('password check', () => {
  it('accepts the right password', () => {
    expect(setup().check(basic('me', PASSWORD))).toEqual({ ok: true })
  })

  it('ignores the username', () => {
    const { check } = setup()
    expect(check(basic('', PASSWORD))).toEqual({ ok: true })
    expect(check(basic('anyone-at-all', PASSWORD))).toEqual({ ok: true })
  })

  it('accepts a password that contains a colon', () => {
    const c = createPasswordCheck({ password: 'pass:with:colons' })
    expect(c.check(basic('u', 'pass:with:colons'))).toEqual({ ok: true })
  })

  it.each([
    ['wrong password', basic('u', 'nope')],
    ['empty password', basic('u', '')],
    ['missing header', undefined],
    ['empty header', ''],
    ['bearer scheme', `Bearer ${PASSWORD}`],
    ['raw password', PASSWORD],
    ['malformed base64', 'Basic !!!not-base64!!!'],
    ['username only (no colon)', `Basic ${Buffer.from('justauser').toString('base64')}`],
    ['basic with nothing', 'Basic '],
  ])('rejects %s with 401', (_name, header) => {
    expect(setup().check(header)).toEqual({ ok: false, status: 401 })
  })

  it('locks out after 8 failures, even for the right password, and lifts after lockoutMs', () => {
    const { check, advance } = setup()
    for (let i = 0; i < 7; i++) expect(check(basic('u', 'bad'))).toEqual({ ok: false, status: 401 })
    expect(check(basic('u', 'bad'))).toEqual({ ok: false, status: 401 })
    const locked = check(basic('u', PASSWORD))
    expect(locked).toEqual({ ok: false, status: 429, retryAfterS: 300 })
    advance(120_000)
    expect(check(basic('u', PASSWORD))).toEqual({ ok: false, status: 429, retryAfterS: 180 })
    advance(180_000)
    expect(check(basic('u', PASSWORD))).toEqual({ ok: true })
  })

  it('does not lock out with 7 failures', () => {
    const { check } = setup()
    for (let i = 0; i < 7; i++) check(basic('u', 'bad'))
    expect(check(basic('u', PASSWORD))).toEqual({ ok: true })
  })

  it('forgets failures older than the window', () => {
    const { check, advance } = setup()
    for (let i = 0; i < 7; i++) check(basic('u', 'bad'))
    advance(5 * 60_000 + 1)
    check(basic('u', 'bad'))
    expect(check(basic('u', PASSWORD))).toEqual({ ok: true })
  })

  it('counts a malformed header as a failure', () => {
    const { check } = setup({ failureLimit: 2 })
    check('garbage')
    check(undefined)
    expect(check(basic('u', PASSWORD))).toMatchObject({ ok: false, status: 429 })
  })

  it('does not extend the lock by attempts made during it', () => {
    const { check, advance } = setup({ failureLimit: 1, lockoutMs: 10_000 })
    check(basic('u', 'bad'))
    advance(9_000)
    expect(check(basic('u', 'bad'))).toMatchObject({ status: 429 })
    advance(1_000)
    expect(check(basic('u', PASSWORD))).toEqual({ ok: true })
  })

  it('never puts the password in a result', () => {
    const { check } = setup({ failureLimit: 1 })
    const results = [check(basic('u', 'bad')), check(basic('u', PASSWORD))]
    expect(JSON.stringify(results)).not.toContain(PASSWORD)
  })
})
