import { describe, expect, it } from 'vitest'
import { dayStartMs, jakartaDay, type JakartaDay } from './jakartaClock'
import { daySchedule } from './schedule'

const DAY_MS = 86400000
const MON = jakartaDay(Date.parse('2026-11-09T12:00:00+07:00'))
const FRI = jakartaDay(Date.parse('2026-11-06T12:00:00+07:00'))
const dayAfter = (d: JakartaDay, n: number) => jakartaDay(dayStartMs(d) + n * DAY_MS + 12 * 3600000)
const hm = (day: JakartaDay, ms: number) => {
  const m = Math.round((ms - dayStartMs(day)) / 60000)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const on = { id: 'agent-1', takesPrayerBreaks: true }
const off = { id: 'agent-1', takesPrayerBreaks: false }

describe('daySchedule', () => {
  it('has all five prayers, lunch and three coffees on a weekday, with the prayer setting on', () => {
    const events = daySchedule(on, MON)
    expect(events.filter((e) => e.kind === 'prayer').map((e) => e.prayer)).toEqual(['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'])
    expect(events.filter((e) => e.kind === 'lunch')).toHaveLength(1)
    // Prayers hold the floor, so a coffee that lands on one is dropped; the rest are kept.
    expect(events.filter((e) => e.kind === 'coffee').length).toBeLessThanOrEqual(3)
    const plain = daySchedule(off, MON)
    expect(plain.filter((e) => e.kind === 'coffee')).toHaveLength(3)
  })
  it('with the setting off has no prayers and still has lunch', () => {
    const events = daySchedule(off, MON)
    expect(events.some((e) => e.kind === 'prayer')).toBe(false)
    const lunch = events.find((e) => e.kind === 'lunch')!
    expect(lunch.label).toBe('On lunch')
    expect(lunch.endMs - lunch.startMs).toBe(3600000)
  })
  it('on a Friday the group shares 11:45 to 13:00, with no separate Dzuhur or lunch', () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      const events = daySchedule({ id, takesPrayerBreaks: true }, FRI)
      const friday = events.filter((e) => e.kind === 'friday')
      expect(friday).toHaveLength(1)
      expect(hm(FRI, friday[0].startMs)).toBe('11:45')
      expect(hm(FRI, friday[0].endMs)).toBe('13:00')
      expect(friday[0].label).toBe('Friday prayer and lunch')
      expect(events.some((e) => e.kind === 'lunch' || e.prayer === 'dzuhur')).toBe(false)
      expect(events.filter((e) => e.kind === 'prayer')).toHaveLength(4)
    }
  })
  it('on a Friday with the setting off, ordinary lunch', () => {
    const events = daySchedule(off, FRI)
    expect(events.some((e) => e.kind === 'friday')).toBe(false)
    expect(events.filter((e) => e.kind === 'lunch')).toHaveLength(1)
  })
  it('prayer goes first where it overlaps lunch, and lunch keeps its end', () => {
    let found = 0
    for (let d = 0; d < 40; d++) {
      const day = dayAfter(MON, d)
      if (day.weekday === 5) continue
      for (let i = 0; i < 60; i++) {
        const agent = { id: `agent-${i}`, takesPrayerBreaks: true }
        const events = daySchedule(agent, day)
        const dzuhur = events.find((e) => e.prayer === 'dzuhur')!
        const lunch = events.find((e) => e.kind === 'lunch')!
        if (dzuhur.endMs > lunch.endMs - 3600000 && dzuhur.startMs < lunch.endMs && lunch.startMs === dzuhur.endMs) {
          found++
          expect(hm(day, lunch.endMs) >= '13:00' && hm(day, lunch.endMs) <= '13:05').toBe(true)
        }
      }
    }
    expect(found).toBeGreaterThan(0)
  })
  it('events never overlap, on every day of a whole year, for many agent ids', () => {
    for (let d = 0; d < 366; d++) {
      const day = dayAfter(jakartaDay(Date.parse('2026-01-01T12:00:00+07:00')), d)
      for (let i = 0; i < 40; i++) {
        for (const takesPrayerBreaks of [true, false]) {
          const events = daySchedule({ id: `agent-${i}`, takesPrayerBreaks }, day)
          for (let k = 0; k < events.length; k++) {
            expect(events[k].endMs).toBeGreaterThan(events[k].startMs)
            if (k > 0) expect(events[k].startMs, `${day.key} agent-${i}`).toBeGreaterThanOrEqual(events[k - 1].endMs)
          }
        }
      }
    }
  })
  it('holds is true only for lunch, friday and prayer', () => {
    for (const day of [MON, FRI]) for (const a of [on, off]) for (const e of daySchedule(a, day)) expect(e.holds).toBe(e.kind !== 'coffee')
  })
  it('the same agent and day give the same schedule, and agents differ', () => {
    expect(daySchedule(on, MON)).toEqual(daySchedule({ ...on }, MON))
    const starts = new Set(Array.from({ length: 20 }, (_, i) => daySchedule({ id: `agent-${i}`, takesPrayerBreaks: false }, MON).find((e) => e.kind === 'lunch')!.startMs))
    expect(starts.size).toBeGreaterThan(1)
    for (const s of starts) expect(s - dayStartMs(MON)).toBeGreaterThanOrEqual(12 * 3600000)
  })
  it('takes nothing but the id and the prayer setting', () => {
    const extra = { id: 'agent-1', takesPrayerBreaks: true, name: 'Someone', status: 'working', deskId: 'desk-01' }
    expect(daySchedule(extra, MON)).toEqual(daySchedule(on, MON))
  })
})
