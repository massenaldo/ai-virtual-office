// The office's own clock. The server says what time the office thinks it is (and how fast it runs, for the dev setting);
// the browser anchors that to its own monotonic-enough clock when the reply arrives. Pure: no React, no I/O.

/** What /api/state carries. `nowMs` is the office time at the moment the response was built. */
export type OfficeClockInfo = { nowMs: number; speed: number; routine: boolean }

export type OfficeClock = {
  /** The office time now, in ms since the epoch. */
  now(): number
  /** The office time at a real instant (ms since the epoch). */
  fromReal(realMs: number): number
  /** False when the routine is switched off: agents stay at their desks. */
  routine: boolean
}

export const MIN_SPEED = 1
export const MAX_SPEED = 3600
/** The largest instant a Date can hold. */
const MAX_DATE_MS = 8.64e15

/** With no info (browser-only demo, or an older server) the office runs on real time with the routine on. */
export function createOfficeClock(info: OfficeClockInfo | null, realNow: () => number): OfficeClock {
  if (!info) return { now: realNow, fromReal: (realMs) => realMs, routine: true }
  const anchorReal = realNow()
  const fromReal = (realMs: number) => info.nowMs + (realMs - anchorReal) * info.speed
  return { now: () => fromReal(realNow()), fromReal, routine: info.routine }
}

/** Only a well-formed value counts. Anything else (an older server, a damaged reply) is null, which means real time. */
export function parseOfficeClockInfo(v: unknown): OfficeClockInfo | null {
  if (typeof v !== 'object' || v === null) return null
  const { nowMs, speed, routine } = v as Record<string, unknown>
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_DATE_MS) return null
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return null
  if (typeof routine !== 'boolean') return null
  return { nowMs, speed, routine }
}

/** `Jakarta 12:03`, plus `×60` when the clock is sped up. */
export function officeClockLabel(nowMs: number, speed: number): string {
  const d = new Date(nowMs + 7 * 3600000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `Jakarta ${hh}:${mm}${speed > 1 ? ` ×${Number.isInteger(speed) ? speed : speed.toFixed(1)}` : ''}`
}
