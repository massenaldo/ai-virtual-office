import type { OfficeClockInfo } from '../src/office/officeClock'
import { MAX_SPEED, MIN_SPEED } from '../src/office/officeClock'
import type { ServerConfig } from './config'

export type DevClock = { startMs: number; speed: number }

// A start time with an explicit offset or Z (a bare local time would mean different things on different machines).
const START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const SPEED = /^\d+(\.\d+)?$/

/** `2026-11-09T11:40:00+07:00@60`: the office starts at that time and runs that many times faster than real. Unset is null; anything unreadable is 'invalid'. */
export function parseDevClock(raw: string | undefined): DevClock | null | 'invalid' {
  if (raw === undefined) return null
  const at = raw.lastIndexOf('@')
  if (at < 0) return 'invalid'
  const start = raw.slice(0, at)
  const speedText = raw.slice(at + 1)
  if (!START.test(start) || !SPEED.test(speedText)) return 'invalid'
  const startMs = Date.parse(start)
  const speed = Number(speedText)
  if (!Number.isFinite(startMs) || !Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return 'invalid'
  return { startMs, speed }
}

/**
 * The office clock as it is at this instant. Computed when the response is built, never stored. `bootRealMs` is the real
 * time the dev clock's start time corresponds to. This touches nothing else: task, audit, session and timeout times stay real.
 */
export function officeClockInfo(config: Pick<ServerConfig, 'devClock' | 'officeRoutine'>, realNow: () => number, bootRealMs: number): OfficeClockInfo {
  const dev = config.devClock
  if (!dev) return { nowMs: realNow(), speed: 1, routine: config.officeRoutine }
  return { nowMs: dev.startMs + (realNow() - bootRealMs) * dev.speed, speed: dev.speed, routine: config.officeRoutine }
}
