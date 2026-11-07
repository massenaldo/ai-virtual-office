import { stableHash } from './hash'
import { dayStartMs, type JakartaDay } from './jakartaClock'
import { prayerTimes, type PrayerName } from './prayerTimes'

export type BreakKind = 'coffee' | 'lunch' | 'prayer' | 'friday'
export type BreakEvent = { kind: BreakKind; prayer: PrayerName | null; startMs: number; endMs: number; holds: boolean; label: string }

const MINUTE = 60_000
const FRIDAY = 5
const COFFEE_MINUTES = [10 * 60 + 30, 15 * 60 + 45, 21 * 60]
const COFFEE_LENGTH = 15
const LUNCH_START = 12 * 60
const LUNCH_LENGTH = 60
const FRIDAY_START = 11 * 60 + 45
const FRIDAY_END = 13 * 60
const PRAYER_LENGTH = 15
const PRAYERS: PrayerName[] = ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya']
const MAX_OFFSET = 5

/** 0 to 5 whole minutes, fixed by the agent, the day and the event, so agents drift apart in ones and twos. */
const offsetFor = (id: string, day: JakartaDay, event: string) => stableHash(`${id}:${day.key}:${event}`) % (MAX_OFFSET + 1)

/**
 * One agent's breaks for one Jakarta day, sorted and never overlapping. It reads the agent's id and its prayer setting and
 * nothing else, so the same day always gives the same answer.
 */
export function daySchedule(agent: { id: string; takesPrayerBreaks: boolean }, day: JakartaDay): BreakEvent[] {
  const base = dayStartMs(day)
  const at = (minutes: number) => base + Math.round(minutes) * MINUTE
  const friday = day.weekday === FRIDAY && agent.takesPrayerBreaks
  const events: BreakEvent[] = []

  if (agent.takesPrayerBreaks) {
    const times = prayerTimes(day)
    for (const name of PRAYERS) {
      if (friday && name === 'dzuhur') continue
      const start = at(times[name] + offsetFor(agent.id, day, `prayer-${name}`))
      events.push({ kind: 'prayer', prayer: name, startMs: start, endMs: start + PRAYER_LENGTH * MINUTE, holds: true, label: 'Praying' })
    }
  }

  if (friday) {
    events.push({ kind: 'friday', prayer: null, startMs: at(FRIDAY_START), endMs: at(FRIDAY_END), holds: true, label: 'Friday prayer and lunch' })
  } else {
    const start = at(LUNCH_START + offsetFor(agent.id, day, 'lunch'))
    const lunch: BreakEvent = { kind: 'lunch', prayer: null, startMs: start, endMs: start + LUNCH_LENGTH * MINUTE, holds: true, label: 'On lunch' }
    // Prayer goes first; lunch takes what is left of its hour and keeps its end.
    for (const p of events.filter((e) => e.kind === 'prayer')) {
      if (p.startMs >= lunch.endMs || p.endMs <= lunch.startMs) continue
      if (p.startMs <= lunch.startMs || p.endMs < lunch.endMs) lunch.startMs = Math.max(lunch.startMs, p.endMs)
      else lunch.endMs = p.startMs
    }
    if (lunch.endMs > lunch.startMs) events.push(lunch)
  }

  const holding = [...events]
  COFFEE_MINUTES.forEach((minutes, i) => {
    const start = at(minutes + offsetFor(agent.id, day, `coffee-${i}`))
    const end = start + COFFEE_LENGTH * MINUTE
    // A coffee that would cut into something that holds is dropped.
    if (!holding.some((e) => start < e.endMs && end > e.startMs)) events.push({ kind: 'coffee', prayer: null, startMs: start, endMs: end, holds: false, label: 'Coffee' })
  })
  return events.sort((a, b) => a.startMs - b.startMs)
}
