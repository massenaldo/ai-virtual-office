import { seatForDesk, type Seat } from '../layout/seats'
import type { OfficeLayout } from '../layout/types'
import { breakSpots, type BreakSpot } from './breakSpots'
import { stableHash } from './hash'
import { dayStartMs, jakartaDay, type JakartaDay } from './jakartaClock'
import { daySchedule, type BreakEvent } from './schedule'
import { createWalkMap, headingOf, pointAlong, routeLength, type Point, type WalkMap } from './walkMap'

// Where every agent is at any instant, worked out from the agents, the layout and the time alone. Nothing here remembers a
// moment: the caches below only keep answers that cannot change, and are cleared when they grow, so asking in any order
// gives the same result.

/** Metres per second. */
export const WALK_SPEED = 1.2
export const CHAT_MS = 5 * 60_000

export type RoutineAgent = {
  id: string
  deskId: string | null
  takesPrayerBreaks: boolean
  /** When its active task started, or null. */
  activeSince: number | null
  /** When its last task ended, or null. */
  busyUntil: number | null
}
export type PresenceState = 'at-desk' | 'walking' | 'chatting' | 'coffee' | 'lunch' | 'praying'
/** `rotation` is in degrees with the rig's convention: 0 faces -Z, and a positive value turns toward -X. */
export type Presence = { state: PresenceState; x: number; z: number; rotation: number; pose: 'sit' | 'stand' | 'walk'; label: string | null; bubble: boolean }
export type Chat = { startMs: number; a: string; b: string; x: number; z: number }

const MINUTE = 60_000
const DAY_MS = 86_400_000
const CHAT_SLOTS = 3
const CHAT_FIRST_MINUTE = 9 * 60
const CHAT_LAST_MINUTE = 22 * 60
const CHAT_GAP = 0.45
/** How many nearest colleagues an agent tries before it gives up on a chat in a slot. */
const CHAT_TRIES = 4
const CHAT_SPREAD_MINUTES = 90
const CHAT_SHIFTS = 6
const CHAT_SHIFT_MINUTES = 15
const MAX_DAYS_KEPT = 4

type Stance = { x: number; z: number; rotation: number; pose: 'sit' | 'stand' }
type Plan = { startMs: number; endMs: number; state: PresenceState; label: string; spot: Stance | null; bubble: boolean }
/** A walk along a route from `startMs`. Afterwards the agent stays at the end until the next leg takes over. */
type Leg = { startMs: number; route: Point[]; arriveMs: number; plan: Plan | null }
type Itinerary = { legs: Leg[]; duds: Plan[] }
type ChatPlan = Chat & { endMs: number; stanceA: Stance; stanceB: Stance }
type Day = { day: JakartaDay; start: number; end: number }
type AgentRecord = {
  agent: RoutineAgent
  index: number
  seat: Seat
  home: Point
  schedules: Map<number, BreakEvent[]>
  itineraries: Map<number, Itinerary>
  /** The walk home after a task starts, once worked out. `undefined` until then. */
  activeWalk?: { route: Point[] | null; arriveMs: number }
}

const walkMs = (route: Point[]) => (routeLength(route) / WALK_SPEED) * 1000
const remember = <K, V>(cache: Map<K, V>, key: K, value: V): V => {
  if (cache.size >= MAX_DAYS_KEPT) cache.clear()
  cache.set(key, value)
  return value
}

const STATE_OF: Record<BreakEvent['kind'], PresenceState> = { coffee: 'coffee', lunch: 'lunch', friday: 'lunch', prayer: 'praying' }

const walkMaps = new WeakMap<OfficeLayout, WalkMap>()
/** One map per layout object, with its routes, because the routine is rebuilt whenever a task starts or ends and the layout hasn't changed. */
export function walkMapFor(layout: OfficeLayout): WalkMap {
  let map = walkMaps.get(layout)
  if (!map) walkMaps.set(layout, (map = createWalkMap(layout)))
  return map
}

export function createRoutine(agents: RoutineAgent[], layout: OfficeLayout): { presenceAt(agentId: string, nowMs: number): Presence | null; chatsOn(day: JakartaDay): Chat[] } {
  const map = walkMapFor(layout)
  const sorted = [...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const desks = new Map(layout.furniture.filter((f) => f.type === 'desk').map((f) => [f.id, f]))
  const records = new Map<string, AgentRecord>()
  sorted.forEach((agent) => {
    const desk = agent.deskId === null ? undefined : desks.get(agent.deskId)
    if (!desk) return
    const seat = seatForDesk(layout, desk)
    // Numbered among agents with a desk, so one with no character never uses up a chair, a mat or a place at the counter.
    records.set(agent.id, { agent, index: records.size, seat, home: { x: seat.x, z: seat.z }, schedules: new Map(), itineraries: new Map() })
  })

  // Spots nobody can walk to are left out, so a cramped room gives its reachable places to the first agents.
  let spotLists: { coffee: BreakSpot[]; dining: BreakSpot[]; prayer: BreakSpot[] } | null = null
  const spots = () => {
    if (spotLists) return spotLists
    const all = breakSpots(layout)
    const regions = new Set<number>()
    for (const r of records.values()) {
      const region = map.regionOf(r.home)
      if (region !== null) regions.add(region)
    }
    const reachable = (list: BreakSpot[]) => list.filter((s) => {
      const region = map.regionOf(s)
      return region !== null && regions.has(region)
    })
    return (spotLists = { coffee: reachable(all.coffee), dining: reachable(all.dining), prayer: reachable(all.prayer) })
  }
  const spotFor = (record: AgentRecord, kind: BreakEvent['kind'], day: JakartaDay): Stance | null => {
    const lists = spots()
    if (kind === 'coffee') {
      // The kitchen holds fewer than a full office, so who stays at their desk changes from day to day.
      return lists.coffee[(record.index + stableHash(`coffee:${day.key}`)) % records.size] ?? null
    }
    return (kind === 'prayer' ? lists.prayer : lists.dining)[record.index] ?? null
  }

  let lastDay: Day | null = null
  const dayAt = (ms: number): Day => {
    if (lastDay && ms >= lastDay.start && ms < lastDay.end) return lastDay
    const day = jakartaDay(ms)
    const start = dayStartMs(day)
    return (lastDay = { day, start, end: start + DAY_MS })
  }

  const scheduleOf = (record: AgentRecord, day: Day): BreakEvent[] =>
    record.schedules.get(day.start) ?? remember(record.schedules, day.start, daySchedule(record.agent, day.day))

  const busyAt = (record: AgentRecord, ms: number) => record.agent.activeSince !== null && ms >= record.agent.activeSince

  // ---- chats ----

  function meeting(a: AgentRecord, b: AgentRecord): { x: number; z: number; stanceA: Stance; stanceB: Stance } | null {
    const middle = map.nearestFree({ x: (a.home.x + b.home.x) / 2, z: (a.home.z + b.home.z) / 2 })
    if (!middle) return null
    let ux = b.home.x - a.home.x
    let uz = b.home.z - a.home.z
    const length = Math.hypot(ux, uz)
    if (length < 1e-6) {
      ux = 1
      uz = 0
    } else {
      ux /= length
      uz /= length
    }
    for (const [dx, dz] of [[ux, uz], [-uz, ux]]) {
      const pa = { x: middle.x - dx * CHAT_GAP, z: middle.z - dz * CHAT_GAP }
      const pb = { x: middle.x + dx * CHAT_GAP, z: middle.z + dz * CHAT_GAP }
      if (!map.isFree(pa) || !map.isFree(pb)) continue
      if (!map.route(a.home, pa) || !map.route(pa, a.home) || !map.route(b.home, pb) || !map.route(pb, b.home)) continue
      return {
        x: middle.x,
        z: middle.z,
        stanceA: { ...pa, rotation: headingOf(pb.x - pa.x, pb.z - pa.z), pose: 'stand' },
        stanceB: { ...pb, rotation: headingOf(pa.x - pb.x, pa.z - pb.z), pose: 'stand' },
      }
    }
    return null
  }

  function computeChats(day: Day): ChatPlan[] {
    const chats: ChatPlan[] = []
    const people = sorted.map((a) => records.get(a.id)).filter((r): r is AgentRecord => r !== undefined)
    if (people.length < 2) return chats
    const room = CHAT_LAST_MINUTE - CHAT_FIRST_MINUTE - CHAT_MS / MINUTE
    // One slot in each part of the day, so slots can't pile up on each other.
    const part = Math.floor(room / CHAT_SLOTS)
    for (let n = 0; n < CHAT_SLOTS; n++) {
      const slotMinute = CHAT_FIRST_MINUTE + n * part + (stableHash(`chat:${day.day.key}:${n}`) % Math.max(1, part - CHAT_SPREAD_MINUTES))
      // Each pair gets its own time within the slot, so people drift off in ones and twos, not all at once. A clash moves it along.
      const pairStarts = (a: AgentRecord, b: AgentRecord) => {
        const [x, y] = a.agent.id < b.agent.id ? [a.agent.id, b.agent.id] : [b.agent.id, a.agent.id]
        const offset = stableHash(`chat:${day.day.key}:${n}:${x}+${y}`)
        return Array.from({ length: CHAT_SHIFTS }, (_, k) => day.start + (slotMinute + (offset + k * CHAT_SHIFT_MINUTES) % CHAT_SPREAD_MINUTES) * MINUTE)
      }
      const freeAt = (r: AgentRecord, startMs: number) => {
        const endMs = startMs + CHAT_MS
        return !busyAt(r, startMs) &&
          !scheduleOf(r, day).some((e) => e.startMs < endMs && e.endMs > startMs) &&
          !chats.some((c) => (c.a === r.agent.id || c.b === r.agent.id) && c.startMs < endMs && c.endMs > startMs)
      }
      const free = people.filter((r) => !busyAt(r, day.start + slotMinute * MINUTE))
      // With an odd number free, a different one sits each slot out, so nobody is always left over.
      if (free.length % 2 === 1 && free.length >= 3) free.splice(n % free.length, 1)
      const paired = new Set<string>()
      for (const r of free) {
        if (paired.has(r.agent.id)) continue
        const options = free
          .filter((o) => o !== r && !paired.has(o.agent.id))
          .map((o) => ({ o, d: Math.hypot(o.home.x - r.home.x, o.home.z - r.home.z) }))
          .sort((p, q) => p.d - q.d || (p.o.agent.id < q.o.agent.id ? -1 : 1))
          .slice(0, CHAT_TRIES)
        // Which of the nearest colleagues comes first changes by day and slot, so the same pairs don't always talk.
        const first = options.length === 0 ? 0 : stableHash(`chat:${day.day.key}:${n}:${r.agent.id}`) % options.length
        for (const { o } of [...options.slice(first), ...options.slice(0, first)]) {
          const startMs = pairStarts(r, o).find((s) => freeAt(r, s) && freeAt(o, s))
          if (startMs === undefined) continue
          const spot = meeting(r, o)
          if (!spot) continue
          const endMs = startMs + CHAT_MS
          paired.add(r.agent.id)
          paired.add(o.agent.id)
          chats.push({ startMs, endMs, a: r.agent.id, b: o.agent.id, x: spot.x, z: spot.z, stanceA: spot.stanceA, stanceB: spot.stanceB })
          break
        }
      }
    }
    return chats.sort((p, q) => p.startMs - q.startMs || (p.a < q.a ? -1 : 1))
  }

  const chatCache = new Map<number, { plans: ChatPlan[]; chats: Chat[] }>()
  const chatsFor = (day: Day) => {
    const cached = chatCache.get(day.start)
    if (cached) return cached
    const plans = computeChats(day)
    return remember(chatCache, day.start, { plans, chats: plans.map(({ startMs, a, b, x, z }) => ({ startMs, a, b, x, z })) })
  }

  // ---- itineraries ----

  function plansFor(record: AgentRecord, day: Day): Plan[] {
    const plans: Plan[] = scheduleOf(record, day).map((e) => ({ startMs: e.startMs, endMs: e.endMs, state: STATE_OF[e.kind], label: e.label, spot: spotFor(record, e.kind, day.day), bubble: false }))
    for (const c of chatsFor(day).plans) {
      if (c.a !== record.agent.id && c.b !== record.agent.id) continue
      plans.push({ startMs: c.startMs, endMs: c.endMs, state: 'chatting', label: 'Chatting', spot: c.a === record.agent.id ? c.stanceA : c.stanceB, bubble: true })
    }
    return plans.sort((p, q) => p.startMs - q.startMs)
  }

  /** Where the legs have the agent at an instant: at its desk until the first leg starts. */
  function positionAt(legs: Leg[], ms: number, home: Point): Point {
    for (let i = legs.length - 1; i >= 0; i--) {
      const leg = legs[i]
      if (leg.startMs > ms) continue
      return ms >= leg.arriveMs ? leg.route[leg.route.length - 1] : pointAlong(leg.route, (WALK_SPEED * (ms - leg.startMs)) / 1000)
    }
    return home
  }

  function build(record: AgentRecord, day: Day): Itinerary {
    const legs: Leg[] = []
    const duds: Plan[] = []
    const busy = record.agent.busyUntil
    for (const plan of plansFor(record, day)) {
      if (!plan.spot) {
        duds.push(plan)
        continue
      }
      // A task that ended during the break: the walk starts then, or nothing happens if the break is nearly over.
      const late = busy !== null && busy > plan.startMs && busy < plan.endMs
      const departAt = late ? busy : plan.startMs
      const out = map.route(positionAt(legs, departAt, record.home), plan.spot)
      if (!out) {
        duds.push(plan)
        continue
      }
      const arriveMs = departAt + walkMs(out)
      if (late && arriveMs >= plan.endMs) continue
      // A walk longer than the break turns back where it has got to.
      const leavingFrom: Point = arriveMs < plan.endMs ? plan.spot : pointAlong(out, (WALK_SPEED * (plan.endMs - departAt)) / 1000)
      const back = map.route(leavingFrom, record.home)
      if (!back) {
        duds.push(plan)
        continue
      }
      legs.push({ startMs: departAt, route: out, arriveMs, plan }, { startMs: plan.endMs, route: back, arriveMs: plan.endMs + walkMs(back), plan: null })
    }
    return { legs, duds }
  }

  const itineraryFor = (record: AgentRecord, day: Day) => record.itineraries.get(day.start) ?? remember(record.itineraries, day.start, build(record, day))

  // ---- presence ----

  const desk = (record: AgentRecord, state: PresenceState, label: string | null): Presence =>
    ({ state, x: record.seat.x, z: record.seat.z, rotation: record.seat.rotation, pose: record.seat.seated ? 'sit' : 'stand', label, bubble: false })

  function walking(x: number, z: number, heading: number, label: string | null): Presence {
    return { state: 'walking', x, z, rotation: heading, pose: 'walk', label, bubble: false }
  }

  function inItinerary(record: AgentRecord, itinerary: Itinerary, ms: number): Presence {
    const legs = itinerary.legs
    for (let i = legs.length - 1; i >= 0; i--) {
      const leg = legs[i]
      if (leg.startMs > ms) continue
      if (ms < leg.arriveMs) {
        const p = pointAlong(leg.route, (WALK_SPEED * (ms - leg.startMs)) / 1000)
        return walking(p.x, p.z, p.heading, leg.plan ? leg.plan.label : null)
      }
      if (leg.plan?.spot) {
        const { spot, state, label, bubble } = leg.plan
        return { state, x: spot.x, z: spot.z, rotation: spot.rotation, pose: spot.pose, label, bubble }
      }
      break
    }
    for (const d of itinerary.duds) if (ms >= d.startMs && ms < d.endMs) return desk(record, d.state, d.label)
    return desk(record, 'at-desk', null)
  }

  /** After a task starts: back to the desk from wherever the day's plan had the agent at that moment. */
  function afterTaskStarted(record: AgentRecord, ms: number): Presence {
    const startedAt = record.agent.activeSince!
    if (!record.activeWalk) {
      const here = positionAt(itineraryFor(record, dayAt(startedAt)).legs, startedAt, record.home)
      const atDesk = here.x === record.home.x && here.z === record.home.z
      const route = atDesk ? null : map.route(here, record.home)
      record.activeWalk = { route, arriveMs: route ? startedAt + walkMs(route) : startedAt }
    }
    const { route, arriveMs } = record.activeWalk
    if (route && ms < arriveMs) {
      const p = pointAlong(route, (WALK_SPEED * (ms - startedAt)) / 1000)
      return walking(p.x, p.z, p.heading, null)
    }
    return desk(record, 'at-desk', null)
  }

  return {
    presenceAt(agentId, nowMs) {
      const record = records.get(agentId)
      if (!record || !Number.isFinite(nowMs)) return null
      const since = record.agent.activeSince
      if (since !== null && nowMs >= since) return afterTaskStarted(record, nowMs)
      return inItinerary(record, itineraryFor(record, dayAt(nowMs)), nowMs)
    },
    chatsOn(day) {
      return chatsFor({ day, start: dayStartMs(day), end: dayStartMs(day) + DAY_MS }).chats
    },
  }
}
