import { describe, expect, it } from 'vitest'
import { createOfficeClock, officeClockLabel, parseOfficeClockInfo } from './officeClock'

const T0 = Date.parse('2026-11-09T11:40:00+07:00')

describe('createOfficeClock', () => {
  it('follows the server, not the local clock', () => {
    const local = Date.parse('2026-11-09T08:40:00+07:00') // three hours behind the server
    const clock = createOfficeClock({ nowMs: T0, speed: 1, routine: true }, () => local)
    expect(clock.now()).toBe(T0)
  })

  it('runs at the given speed', () => {
    let real = 1_000_000
    const clock = createOfficeClock({ nowMs: T0, speed: 60, routine: true }, () => real)
    real += 60_000
    expect(clock.now()).toBe(T0 + 3_600_000)
  })

  it('maps a real time onto office time', () => {
    const real = 5_000_000
    const clock = createOfficeClock({ nowMs: T0, speed: 60, routine: true }, () => real)
    expect(clock.fromReal(real)).toBe(T0)
    expect(clock.fromReal(real + 1000)).toBe(T0 + 60_000)
    expect(clock.fromReal(real - 1000)).toBe(T0 - 60_000)
  })

  it('falls back to real time on null, with the routine on', () => {
    let real = 42
    const clock = createOfficeClock(null, () => real)
    expect(clock.now()).toBe(42)
    real = 99
    expect(clock.now()).toBe(99)
    expect(clock.fromReal(7)).toBe(7)
    expect(clock.routine).toBe(true)
  })

  it('carries the routine setting', () => {
    expect(createOfficeClock({ nowMs: T0, speed: 1, routine: false }, () => 0).routine).toBe(false)
  })
})

describe('parseOfficeClockInfo', () => {
  it('accepts a well-formed value', () => {
    expect(parseOfficeClockInfo({ nowMs: T0, speed: 60, routine: false })).toEqual({ nowMs: T0, speed: 60, routine: false })
    expect(parseOfficeClockInfo({ nowMs: T0, speed: 1, routine: true, extra: 1 })).toEqual({ nowMs: T0, speed: 1, routine: true })
    expect(parseOfficeClockInfo({ nowMs: T0, speed: 3600, routine: true })).not.toBeNull()
  })

  it.each([
    [undefined], [null], ['x'], [5], [[]], [{}], [{ nowMs: 'x', speed: 1, routine: true }],
    [{ nowMs: 1, speed: 0, routine: true }], [{ nowMs: 1, speed: 1 }], [{ nowMs: 1, speed: 3601, routine: true }],
    [{ nowMs: 1, speed: 0.5, routine: true }], [{ nowMs: 1, speed: Infinity, routine: true }], [{ nowMs: NaN, speed: 1, routine: true }],
    [{ nowMs: Infinity, speed: 1, routine: true }], [{ nowMs: 9e15, speed: 1, routine: true }], [{ nowMs: 1, speed: '1', routine: true }], [{ nowMs: 1, speed: 1, routine: 'on' }],
  ])('rejects %o', (v) => {
    expect(parseOfficeClockInfo(v)).toBeNull()
  })
})

describe('officeClockLabel', () => {
  it('shows Jakarta time whatever the viewer zone', () => {
    expect(officeClockLabel(Date.parse('2026-11-09T12:03:00+07:00'), 1)).toBe('Jakarta 12:03')
    expect(officeClockLabel(Date.parse('2026-11-09T00:05:00Z'), 1)).toBe('Jakarta 07:05')
  })
  it('adds the speed when sped up', () => {
    expect(officeClockLabel(Date.parse('2026-11-09T12:03:00+07:00'), 60)).toBe('Jakarta 12:03 ×60')
  })
})
