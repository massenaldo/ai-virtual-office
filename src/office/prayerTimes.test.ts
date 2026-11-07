import { describe, expect, it } from 'vitest'
import { jakartaDay } from './jakartaClock'
import { prayerTimes, type PrayerName } from './prayerTimes'

// Fixtures are Jakarta timetables from Bimas Islam Kemenag, as reproduced by Indonesian media:
// - 2026-02-19: momsmoney.kontan.co.id, Ramadan 2026 table for Jakarta Pusat
// - 2026-03-01: tafsirweb.com
// - 2026-05-31 and 2026-07-31: liputan6.com (May and July 2026 tables)
// - 2026-09-23: liputan6.com (September 2026 table), matching journalarta.com's DKI Jakarta table. One other article gives
//   Ashar as 14:52, which disagrees with both tables and with the sun's position.
// The allowed difference is 2 minutes. It must not be widened to make a fixture pass.
const TOLERANCE_MINUTES = 2
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

const FIXTURES: Array<[string, Partial<Record<PrayerName, string>>]> = [
  ['2026-02-19', { subuh: '04:41', dzuhur: '12:10', ashar: '15:20', maghrib: '18:18', isya: '19:28' }],
  ['2026-03-01', { subuh: '04:45', dzuhur: '12:10' }],
  ['2026-05-31', { subuh: '04:36', dzuhur: '11:54' }],
  ['2026-07-31', { subuh: '04:45', dzuhur: '12:03' }],
  ['2026-09-23', { subuh: '04:27', dzuhur: '11:49', ashar: '14:58', maghrib: '17:52', isya: '19:00' }],
]

describe('prayerTimes', () => {
  it.each(FIXTURES)('%s matches a published Jakarta timetable', (date, expected) => {
    const times = prayerTimes(jakartaDay(Date.parse(`${date}T00:00:00+07:00`)))
    for (const [name, hhmm] of Object.entries(expected) as Array<[PrayerName, string]>) {
      expect(Math.abs(times[name] - toMinutes(hhmm)), `${date} ${name}: computed ${times[name].toFixed(1)} min, published ${hhmm}`).toBeLessThanOrEqual(TOLERANCE_MINUTES)
    }
  })
  it('keeps the five prayers in order through the year', () => {
    for (let d = 0; d < 366; d += 5) {
      const t = prayerTimes(jakartaDay(Date.parse('2026-01-01T12:00:00+07:00') + d * 86400000))
      expect([t.subuh, t.dzuhur, t.ashar, t.maghrib, t.isya]).toEqual([t.subuh, t.dzuhur, t.ashar, t.maghrib, t.isya].sort((a, b) => a - b))
    }
  })
})
