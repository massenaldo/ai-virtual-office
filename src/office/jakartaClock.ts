// Jakarta has no daylight saving: it is always UTC+7. Fixed arithmetic keeps the result the same whatever zone the viewer is in.

export type JakartaDay = { year: number; month: number; day: number; /** 0 is Sunday. */ weekday: number; /** Like `2026-11-07`. */ key: string }

const OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function jakartaDay(nowMs: number): JakartaDay {
  const d = new Date(nowMs + OFFSET_MS)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return { year, month, day, weekday: d.getUTCDay(), key: `${pad(year, 4)}-${pad(month)}-${pad(day)}` }
}

/** Whole and fractional minutes since Jakarta midnight. */
export function minutesIntoDay(nowMs: number): number {
  return (((nowMs + OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60000
}

/** The instant Jakarta midnight begins for that day. */
export function dayStartMs(day: JakartaDay): number {
  return Date.UTC(day.year, day.month - 1, day.day) - OFFSET_MS
}
