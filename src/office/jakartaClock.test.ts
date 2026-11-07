import { describe, expect, it } from 'vitest'
import { dayStartMs, jakartaDay, minutesIntoDay } from './jakartaClock'

describe('jakartaClock', () => {
  it('uses Jakarta, not the viewer', () => {
    const now = Date.parse('2026-11-06T17:30:00Z')
    expect(jakartaDay(now)).toEqual({ year: 2026, month: 11, day: 7, weekday: 6, key: '2026-11-07' })
    expect(minutesIntoDay(now)).toBe(30)
  })
  it('changes day at 17:00 UTC exactly', () => {
    expect(jakartaDay(Date.parse('2026-11-06T16:59:59Z')).key).toBe('2026-11-06')
    expect(jakartaDay(Date.parse('2026-11-06T17:00:00Z')).key).toBe('2026-11-07')
  })
  it('round-trips dayStartMs', () => {
    const now = Date.parse('2026-03-01T09:41:00Z')
    const day = jakartaDay(now)
    expect(jakartaDay(dayStartMs(day))).toEqual(day)
    expect(jakartaDay(dayStartMs(day) - 1).key).toBe('2026-02-28')
    expect(minutesIntoDay(dayStartMs(day))).toBe(0)
    expect(minutesIntoDay(now) * 60000 + dayStartMs(day)).toBe(now)
  })
})
