/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { seatForDesk } from '../layout/seats'
import type { Furniture, OfficeLayout } from '../layout/types'
import { breakSpots } from './breakSpots'
import { dayStartMs, jakartaDay } from './jakartaClock'
import { ownerOffice } from './layoutFixtures'
import { CHAT_MS, createRoutine, WALK_SPEED, type Presence, type RoutineAgent } from './presence'
import { daySchedule, type BreakEvent } from './schedule'
import { createWalkMap, routeLength } from './walkMap'

const SECOND = 1000
const MONDAY = jakartaDay(Date.parse('2026-11-09T12:00:00+07:00'))
const FRIDAY = jakartaDay(Date.parse('2026-11-06T12:00:00+07:00'))
const nth = (day: typeof MONDAY, n: number) => jakartaDay(dayStartMs(day) + n * 86400000 + 12 * 3600000)

const agentsFor = (count: number, extra: Partial<RoutineAgent> = {}): RoutineAgent[] =>
  Array.from({ length: count }, (_, i) => ({ id: `agent-${String(i + 1).padStart(2, '0')}`, deskId: `desk-${String(i + 1).padStart(2, '0')}`, takesPrayerBreaks: true, activeSince: null, busyUntil: null, ...extra }))

const withAgent = (agents: RoutineAgent[], id: string, patch: Partial<RoutineAgent>) => agents.map((a) => (a.id === id ? { ...a, ...patch } : a))

const layout = createDefaultLayout()
const walkMap = createWalkMap(layout)
const seatOf = (layoutIn: OfficeLayout, deskId: string) => seatForDesk(layoutIn, layoutIn.furniture.find((f) => f.id === deskId)!)
const walkMs = (route: { x: number; z: number }[]) => (routeLength(route) / WALK_SPEED) * SECOND
const near = (p: { x: number; z: number }, q: { x: number; z: number }, d = 0.05) => Math.hypot(p.x - q.x, p.z - q.z) < d
const event = (agentId: string, day: typeof MONDAY, kind: BreakEvent['kind'], takesPrayerBreaks = true) => daySchedule({ id: agentId, takesPrayerBreaks }, day).find((e) => e.kind === kind)!

describe('presenceAt', () => {
  it('sits at the desk with no event', () => {
    const routine = createRoutine(agentsFor(3), layout)
    const seat = seatOf(layout, 'desk-02')
    const p = routine.presenceAt('agent-02', dayStartMs(MONDAY) + 7 * 3600000)!
    expect(p).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, rotation: seat.rotation, pose: 'sit', label: null, bubble: false })
  })

  it('stands at the desk point when the desk has no chair', () => {
    const noChairs: OfficeLayout = { ...layout, furniture: layout.furniture.filter((f) => f.type !== 'chair') }
    const p = createRoutine(agentsFor(1), noChairs).presenceAt('agent-01', dayStartMs(MONDAY) + 7 * 3600000)!
    expect(p.pose).toBe('stand')
  })

  it('leaves at the event start, arrives at distance / speed, and stays until the end', () => {
    const agents = agentsFor(3, { takesPrayerBreaks: false })
    const routine = createRoutine(agents, layout)
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const seat = seatOf(layout, 'desk-01')
    const spot = breakSpots(layout).dining[0]
    const out = walkMap.route(seat, spot)!
    const there = walkMs(out)
    expect(routine.presenceAt('agent-01', lunch.startMs - SECOND)!.state).toBe('at-desk')
    const midway = routine.presenceAt('agent-01', lunch.startMs + there / 2)!
    expect(midway).toMatchObject({ state: 'walking', pose: 'walk', label: 'On lunch', bubble: false })
    expect(near(midway, seat)).toBe(false)
    expect(near(midway, spot)).toBe(false)
    expect(routine.presenceAt('agent-01', lunch.startMs + there - 100)!.state).toBe('walking')
    for (const t of [lunch.startMs + there + 100, (lunch.startMs + lunch.endMs) / 2, lunch.endMs - SECOND]) {
      expect(routine.presenceAt('agent-01', t)).toMatchObject({ state: 'lunch', x: spot.x, z: spot.z, rotation: spot.rotation, pose: 'sit', label: 'On lunch' })
    }
    const home = routine.presenceAt('agent-01', lunch.endMs + SECOND)!
    expect(home).toMatchObject({ state: 'walking', label: null })
    const back = walkMap.route(spot, seat)!
    expect(routine.presenceAt('agent-01', lunch.endMs + walkMs(back) + 100)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, label: null })
  })

  it('is at the same place however it is called: no state between calls', () => {
    const agents = agentsFor(6)
    const times: number[] = []
    for (const day of [MONDAY, FRIDAY, nth(MONDAY, 3)]) for (let m = 0; m < 24 * 60; m += 7) times.push(dayStartMs(day) + m * 60000 + m * 13)
    const ordered = createRoutine(agents, layout)
    const expected = new Map<string, Presence | null>()
    for (const t of times) for (const a of agents) expected.set(`${a.id}@${t}`, ordered.presenceAt(a.id, t))
    // A seeded shuffle, so a failure can be repeated.
    let seed = 12345
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const shuffled = times.flatMap((t) => agents.map((a) => [a.id, t] as const)).sort(() => random() - 0.5)
    const other = createRoutine(agents, layout)
    for (const [id, t] of shuffled) expect(other.presenceAt(id, t), `${id}@${t}`).toEqual(expected.get(`${id}@${t}`))
    for (const [id, t] of [...shuffled].reverse().slice(0, 600)) expect(ordered.presenceAt(id, t)).toEqual(expected.get(`${id}@${t}`))
  })

  it('gives the same answer whatever zone the process thinks it is in (only the instant matters)', () => {
    const routine = createRoutine(agentsFor(2), layout)
    const t = Date.parse('2026-11-09T05:07:00Z')
    expect(routine.presenceAt('agent-01', t)).toEqual(createRoutine(agentsFor(2), layout).presenceAt('agent-01', t))
  })

  it('walks directly from prayer to lunch when they run together', () => {
    // Find an agent and a day where lunch starts exactly as Dzuhur ends.
    let found: { id: string; day: typeof MONDAY; lunch: BreakEvent; index: number } | null = null
    for (let d = 0; d < 40 && !found; d++) {
      const day = nth(MONDAY, d)
      if (day.weekday === 5) continue
      for (let i = 1; i <= 14 && !found; i++) {
        const id = `agent-${String(i).padStart(2, '0')}`
        const events = daySchedule({ id, takesPrayerBreaks: true }, day)
        const lunch = events.find((e) => e.kind === 'lunch')!
        const dzuhur = events.find((e) => e.prayer === 'dzuhur')!
        if (lunch.startMs === dzuhur.endMs) found = { id, day, lunch, index: i - 1 }
      }
    }
    expect(found).not.toBeNull()
    const { id, lunch, index } = found!
    const routine = createRoutine(agentsFor(14), layout)
    const spots = breakSpots(layout)
    const direct = walkMap.route(spots.prayer[index], spots.dining[index])!
    expect(routine.presenceAt(id, lunch.startMs - SECOND)).toMatchObject({ state: 'praying', x: spots.prayer[index].x, z: spots.prayer[index].z, pose: 'stand', label: 'Praying' })
    const early = routine.presenceAt(id, lunch.startMs + 2 * SECOND)!
    expect(early).toMatchObject({ state: 'walking', label: 'On lunch' })
    const along = Math.min(2 * WALK_SPEED, routeLength(direct))
    // Two seconds into the direct walk it is within 2.5 m of the prayer spot, not back at its desk.
    expect(Math.hypot(early.x - spots.prayer[index].x, early.z - spots.prayer[index].z)).toBeLessThanOrEqual(along + 0.01)
    expect(routine.presenceAt(id, lunch.startMs + walkMs(direct) + 500)).toMatchObject({ state: 'lunch', x: spots.dining[index].x, z: spots.dining[index].z })
  })

  it('an active task keeps the agent at the desk through a break', () => {
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const agents = withAgent(agentsFor(3, { takesPrayerBreaks: false }), 'agent-01', { activeSince: lunch.startMs - 60_000 })
    const routine = createRoutine(agents, layout)
    const seat = seatOf(layout, 'desk-01')
    for (const t of [lunch.startMs - 30_000, lunch.startMs + SECOND, lunch.startMs + 20 * 60000, lunch.endMs - SECOND]) {
      expect(routine.presenceAt('agent-01', t)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, pose: 'sit', label: null })
    }
  })

  it('a task started mid-break walks the agent home from where it was', () => {
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const started = lunch.startMs + 20 * 60000
    const plain = createRoutine(agentsFor(3, { takesPrayerBreaks: false }), layout)
    const routine = createRoutine(withAgent(agentsFor(3, { takesPrayerBreaks: false }), 'agent-01', { activeSince: started }), layout)
    const seat = seatOf(layout, 'desk-01')
    const spot = breakSpots(layout).dining[0]
    expect(routine.presenceAt('agent-01', started - SECOND)).toEqual(plain.presenceAt('agent-01', started - SECOND))
    expect(routine.presenceAt('agent-01', started - SECOND)!.state).toBe('lunch')
    const leaving = routine.presenceAt('agent-01', started + SECOND)!
    expect(leaving).toMatchObject({ state: 'walking', label: null })
    expect(Math.hypot(leaving.x - spot.x, leaving.z - spot.z)).toBeLessThan(2 * WALK_SPEED)
    const back = walkMap.route(spot, seat)!
    expect(routine.presenceAt('agent-01', started + walkMs(back) + 200)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, label: null })
    expect(routine.presenceAt('agent-01', lunch.endMs + 600 * SECOND)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z })
  })

  it('a task started mid-walk turns the agent round at once', () => {
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const out = walkMap.route(seatOf(layout, 'desk-01'), breakSpots(layout).dining[0])!
    const started = lunch.startMs + walkMs(out) / 2
    const routine = createRoutine(withAgent(agentsFor(3, { takesPrayerBreaks: false }), 'agent-01', { activeSince: started }), layout)
    const at = routine.presenceAt('agent-01', started)!
    const later = routine.presenceAt('agent-01', started + SECOND)!
    expect(later.state).toBe('walking')
    expect(later.label).toBeNull()
    expect(Math.hypot(later.x - at.x, later.z - at.z)).toBeLessThanOrEqual(WALK_SPEED + 0.01)
    expect(routine.presenceAt('agent-01', started + 600 * SECOND)).toMatchObject({ state: 'at-desk' })
  })

  it('a task finished mid-break gives the remainder, or nothing if it is too late', () => {
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const seat = seatOf(layout, 'desk-01')
    const spot = breakSpots(layout).dining[0]
    const there = walkMs(walkMap.route(seat, spot)!)
    const finished = lunch.startMs + 10 * 60000
    const routine = createRoutine(withAgent(agentsFor(3, { takesPrayerBreaks: false }), 'agent-01', { busyUntil: finished }), layout)
    expect(routine.presenceAt('agent-01', finished - SECOND)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, label: null })
    expect(routine.presenceAt('agent-01', finished + SECOND)).toMatchObject({ state: 'walking', label: 'On lunch' })
    expect(routine.presenceAt('agent-01', finished + there + 200)).toMatchObject({ state: 'lunch', x: spot.x, z: spot.z })
    expect(routine.presenceAt('agent-01', lunch.endMs - SECOND)).toMatchObject({ state: 'lunch', x: spot.x, z: spot.z })

    const late = createRoutine(withAgent(agentsFor(3, { takesPrayerBreaks: false }), 'agent-01', { busyUntil: lunch.endMs - 3 * SECOND }), layout)
    for (const t of [lunch.startMs + 5 * 60000, lunch.endMs - 2 * SECOND, lunch.endMs + 5 * SECOND, lunch.endMs + 120 * SECOND]) {
      expect(late.presenceAt('agent-01', t)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z, label: null })
    }
  })

  it('more agents than spots: the extras stay at their desks and keep the label', () => {
    const agents = agentsFor(14, { takesPrayerBreaks: false })
    const routine = createRoutine(agents, layout)
    const spots = breakSpots(layout)
    expect(spots.coffee.length).toBeLessThan(14)
    const id = agents[spots.coffee.length].id
    const coffee = daySchedule({ id, takesPrayerBreaks: false }, MONDAY).find((e) => e.kind === 'coffee')!
    const seat = seatOf(layout, agents[spots.coffee.length].deskId!)
    expect(routine.presenceAt(id, (coffee.startMs + coffee.endMs) / 2)).toMatchObject({ state: 'coffee', label: 'Coffee', x: seat.x, z: seat.z, pose: 'sit', bubble: false })
    const first = daySchedule({ id: agents[0].id, takesPrayerBreaks: false }, MONDAY).find((e) => e.kind === 'coffee')!
    expect(routine.presenceAt(agents[0].id, (first.startMs + first.endMs) / 2)).toMatchObject({ state: 'coffee', label: 'Coffee', pose: 'stand' })
  })

  it('a deleted room or a missing route keeps the agent at its desk with the label', () => {
    const lunch = event('agent-01', MONDAY, 'lunch', false)
    const mid = (lunch.startMs + lunch.endMs) / 2
    const seat = seatOf(layout, 'desk-01')
    const noDining: OfficeLayout = { ...layout, rooms: layout.rooms.filter((r) => r.department !== 'dining'), furniture: layout.furniture.filter((f) => !f.id.startsWith('dining')) }
    expect(createRoutine(agentsFor(2, { takesPrayerBreaks: false }), noDining).presenceAt('agent-01', mid)).toMatchObject({ state: 'lunch', label: 'On lunch', x: seat.x, z: seat.z, pose: 'sit' })
    const dining = layout.rooms.find((r) => r.department === 'dining')!
    const seal: Furniture[] = Array.from({ length: 8 }, (_, i) => ({ id: `seal-${i}`, type: 'storage-cabinet', x: dining.x - 1.4 + i * 0.4, z: dining.z + dining.depth / 2 - 0.2, rotation: 0, roomId: dining.id }))
    const sealed: OfficeLayout = { ...layout, furniture: [...layout.furniture, ...seal] }
    const p = createRoutine(agentsFor(2, { takesPrayerBreaks: false }), sealed).presenceAt('agent-01', mid)!
    expect(p).toMatchObject({ state: 'lunch', label: 'On lunch', x: seat.x, z: seat.z })
  })

  it('survives odd layouts without throwing: no rooms, no furniture, no break rooms, overlapping rooms, a deleted desk', () => {
    const overlapping: OfficeLayout = { ...layout, rooms: [...layout.rooms, ...layout.rooms.map((r) => ({ ...r, id: `${r.id}-b`, x: r.x + 0.3, rotation: 90 as const }))] }
    const odd: OfficeLayout[] = [
      { ...layout, rooms: [], furniture: [] },
      { ...layout, rooms: layout.rooms.filter((r) => !['kitchen', 'dining', 'prayer'].includes(r.department)), furniture: layout.furniture.filter((f) => f.roomId === null || !/kitchen|dining|prayer/.test(f.id)) },
      overlapping,
      { ...layout, furniture: layout.furniture.filter((f) => f.id !== 'desk-03') },
      { ...layout, office: { width: 20000, depth: 20000, gridSize: 0.25 } },
      { ...layout, office: { ...layout.office, gridSize: 0 } },
    ]
    for (const l of odd) {
      const routine = createRoutine(agentsFor(14), l)
      for (let h = 0; h < 24; h += 0.5) for (const a of agentsFor(14)) expect(() => routine.presenceAt(a.id, dayStartMs(MONDAY) + h * 3600000)).not.toThrow()
      expect(() => routine.chatsOn(MONDAY)).not.toThrow()
    }
    expect(createRoutine(agentsFor(14), odd[3]).presenceAt('agent-03', dayStartMs(MONDAY) + 3600000)).toBeNull()
  })

  it('no desk or a missing desk gives null', () => {
    const agents: RoutineAgent[] = [{ id: 'a', deskId: null, takesPrayerBreaks: true, activeSince: null, busyUntil: null }, { id: 'b', deskId: 'desk-missing', takesPrayerBreaks: true, activeSince: null, busyUntil: null }, { id: 'c', deskId: 'chair-01', takesPrayerBreaks: true, activeSince: null, busyUntil: null }, { id: 'd', deskId: 'desk-01', takesPrayerBreaks: true, activeSince: null, busyUntil: null }]
    const routine = createRoutine(agents, layout)
    const t = dayStartMs(MONDAY) + 7 * 3600000
    expect(routine.presenceAt('a', t)).toBeNull()
    expect(routine.presenceAt('b', t)).toBeNull()
    expect(routine.presenceAt('c', t)).toBeNull()
    expect(routine.presenceAt('nobody', t)).toBeNull()
    expect(routine.presenceAt('d', t)).not.toBeNull()
  })

  it('prayer setting off: never praying, and ordinary lunch on Fridays', () => {
    const routine = createRoutine(agentsFor(6, { takesPrayerBreaks: false }), layout)
    for (const day of [MONDAY, FRIDAY]) {
      for (let m = 0; m < 24 * 60; m += 3) for (const a of agentsFor(6)) expect(routine.presenceAt(a.id, dayStartMs(day) + m * 60000)!.state).not.toBe('praying')
    }
    const noon = dayStartMs(FRIDAY) + 12 * 3600000
    const lunch = event('agent-01', FRIDAY, 'lunch', false)
    expect(lunch.startMs).toBeGreaterThanOrEqual(noon)
    expect(routine.presenceAt('agent-01', lunch.endMs - 10 * SECOND)).toMatchObject({ state: 'lunch', label: 'On lunch' })
    const praying = createRoutine(agentsFor(6), layout)
    const friday = event('agent-01', FRIDAY, 'friday')
    expect(praying.presenceAt('agent-01', friday.startMs + 5 * 60000)).toMatchObject({ state: 'lunch', label: 'Friday prayer and lunch' })
  })

  it('walks to the coffee counter, the dining table and the prayer mat in the owner office, and back', () => {
    const owner = ownerOffice()
    const agents: RoutineAgent[] = [
      { id: 'mock-alpha', deskId: 'desk-01', takesPrayerBreaks: true, activeSince: null, busyUntil: null },
      { id: 'mock-beta', deskId: 'desk-02', takesPrayerBreaks: true, activeSince: null, busyUntil: null },
    ]
    const routine = createRoutine(agents, owner)
    const map = createWalkMap(owner)
    // The two chairs on the far side of the compact dining table can't be walked to, so the agents take the two others.
    const spots = Object.fromEntries(Object.entries(breakSpots(owner)).map(([k, list]) => [k, list.filter((s) => map.route(seatOf(owner, 'desk-01'), s) !== null)])) as ReturnType<typeof breakSpots>
    expect(spots.dining).toHaveLength(2)
    agents.forEach((agent, index) => {
      const seat = seatOf(owner, agent.deskId!)
      for (const [kind, state, list] of [['coffee', 'coffee', spots.coffee], ['lunch', 'lunch', spots.dining], ['prayer', 'praying', spots.prayer]] as const) {
        const e = daySchedule(agent, MONDAY).find((x) => x.kind === kind)!
        const spot = list[index]
        const there = walkMs(map.route(seat, spot)!)
        expect(there, `${agent.id} ${kind}`).toBeLessThan(e.endMs - e.startMs)
        expect(routine.presenceAt(agent.id, e.startMs + there + 500), `${agent.id} ${kind}`).toMatchObject({ state, x: spot.x, z: spot.z })
        expect(routine.presenceAt(agent.id, e.endMs + walkMs(map.route(spot, seat)!) + 500)).toMatchObject({ state: 'at-desk', x: seat.x, z: seat.z })
      }
    })
  })

  it('two agents in the owner office meet to chat, facing each other, with bubbles', () => {
    const owner = ownerOffice()
    const agents: RoutineAgent[] = [
      { id: 'mock-alpha', deskId: 'desk-01', takesPrayerBreaks: false, activeSince: null, busyUntil: null },
      { id: 'mock-beta', deskId: 'desk-02', takesPrayerBreaks: false, activeSince: null, busyUntil: null },
    ]
    const routine = createRoutine(agents, owner)
    let checked = 0
    for (let d = 0; d < 6; d++) {
      const day = nth(MONDAY, d)
      for (const chat of routine.chatsOn(day)) {
        checked++
        const mid = chat.startMs + 2 * 60000
        const a = routine.presenceAt(chat.a, mid)!
        const b = routine.presenceAt(chat.b, mid)!
        for (const p of [a, b]) expect(p).toMatchObject({ state: 'chatting', bubble: true, label: 'Chatting', pose: 'stand' })
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(0.9, 1)
        // Each one's forward vector, (-sin r, -cos r), points at the other.
        for (const [me, you] of [[a, b], [b, a]]) {
          const r = (me.rotation * Math.PI) / 180
          const dx = you.x - me.x
          const dz = you.z - me.z
          const len = Math.hypot(dx, dz)
          expect((-Math.sin(r) * dx - Math.cos(r) * dz) / len).toBeGreaterThan(0.99)
        }
        expect(Math.hypot((a.x + b.x) / 2 - chat.x, (a.z + b.z) / 2 - chat.z)).toBeLessThan(0.01)
        expect(routine.presenceAt(chat.a, chat.startMs + CHAT_MS + 120 * SECOND)!.bubble).toBe(false)
        expect(routine.presenceAt(chat.a, chat.startMs - SECOND)!.state).not.toBe('chatting')
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('one agent alone never chats', () => {
    const routine = createRoutine(agentsFor(1), layout)
    for (let d = 0; d < 10; d++) expect(routine.chatsOn(nth(MONDAY, d))).toEqual([])
    for (let m = 0; m < 24 * 60; m += 5) expect(routine.presenceAt('agent-01', dayStartMs(MONDAY) + m * 60000)!.state).not.toBe('chatting')
  })

  it('nobody chats during their own break or with a busy colleague', () => {
    const agents = withAgent(agentsFor(14), 'agent-05', { activeSince: dayStartMs(MONDAY) + 8 * 3600000 })
    const routine = createRoutine(agents, layout)
    let chats = 0
    for (let d = 0; d < 5; d++) {
      const day = nth(MONDAY, d)
      for (const chat of routine.chatsOn(day)) {
        chats++
        for (const id of [chat.a, chat.b]) {
          for (const e of daySchedule({ id, takesPrayerBreaks: true }, day)) expect(e.startMs >= chat.startMs + CHAT_MS || e.endMs <= chat.startMs, `${id} ${day.key}`).toBe(true)
        }
        if (day.key === MONDAY.key) expect([chat.a, chat.b]).not.toContain('agent-05')
        const minute = (chat.startMs - dayStartMs(day)) / 60000
        expect(minute).toBeGreaterThanOrEqual(9 * 60)
        expect(minute + 5).toBeLessThanOrEqual(22 * 60)
      }
    }
    expect(chats).toBeGreaterThan(10)
  })

  it('gives 2 to 3 chats per agent on an ordinary day in the default office', () => {
    const routine = createRoutine(agentsFor(14, { takesPrayerBreaks: false }), layout)
    const ordinary = jakartaDay(Date.parse('2026-11-10T12:00:00+07:00'))
    const counts = new Map<string, number>()
    for (const chat of routine.chatsOn(ordinary)) for (const id of [chat.a, chat.b]) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const a of agentsFor(14)) expect(counts.get(a.id), a.id).toBe(3)
  })

  it('over many days nobody has more than 3 chats, and nearly everyone has at least 2', () => {
    // A chat slot that lands on someone's own break leaves them out of it, so the odd day can give one.
    for (const takesPrayerBreaks of [true, false]) {
      const routine = createRoutine(agentsFor(14, { takesPrayerBreaks }), layout)
      let agentDays = 0
      let enough = 0
      for (let d = 0; d < 60; d++) {
        const counts = new Map<string, number>()
        for (const chat of routine.chatsOn(nth(MONDAY, d))) for (const id of [chat.a, chat.b]) counts.set(id, (counts.get(id) ?? 0) + 1)
        for (const a of agentsFor(14)) {
          const n = counts.get(a.id) ?? 0
          expect(n).toBeLessThanOrEqual(3)
          expect(n).toBeGreaterThanOrEqual(1)
          agentDays++
          if (n >= 2) enough++
        }
      }
      expect(enough / agentDays).toBeGreaterThan(0.85)
    }
  })

  it('the same chats come back however often they are asked for', () => {
    const routine = createRoutine(agentsFor(14), layout)
    const first = routine.chatsOn(MONDAY)
    routine.chatsOn(FRIDAY)
    expect(routine.chatsOn(MONDAY)).toEqual(first)
    expect(createRoutine(agentsFor(14), layout).chatsOn(MONDAY)).toEqual(first)
  })

  it('imports neither three nor React, nor the scene or the workforce', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true })
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    for (const [file, text] of Object.entries(sources)) {
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
      for (const spec of imports) {
        expect(/^(three|react|@react-three)/.test(spec) || /\/(scene|workforce)\//.test(spec), `${file} imports ${spec}`).toBe(false)
      }
    }
  })

  it('answers quickly once cached: 14 agents, 1,000 calls each', () => {
    const agents = agentsFor(14)
    const routine = createRoutine(agents, layout)
    const base = dayStartMs(MONDAY) + 6 * 3600000
    for (const a of agents) routine.presenceAt(a.id, base)
    // Warm every route the day uses, so the timing below is the steady state.
    for (let m = 0; m < 24 * 60; m += 10) for (const a of agents) routine.presenceAt(a.id, dayStartMs(MONDAY) + m * 60000)
    const start = performance.now()
    let sink = 0
    for (let i = 0; i < 1000; i++) for (const a of agents) sink += routine.presenceAt(a.id, base + (i % 600) * 60000)!.x
    const perCall = (performance.now() - start) / (1000 * agents.length)
    expect(Number.isFinite(sink)).toBe(true)
    expect(perCall).toBeLessThan(0.1)
    console.info(`presenceAt: ${(perCall * 1000).toFixed(2)} microseconds per call`)
  })
})
