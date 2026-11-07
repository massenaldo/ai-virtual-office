import { describe, expect, it } from 'vitest'
import { BREAK_DEPARTMENTS } from './catalog'
import { breakAreaItems, compactBreakArea, findRoomSpot, withBreakAreasIfTheyFit } from './breakAreas'
import { createDefaultLayout } from './defaultLayout'
import { furnitureRect, rectInsideOffice, rectsOverlap, roomRect, rotateOffset } from './geometry'
import type { Furniture, OfficeLayout, Room } from './types'
import { findIssues } from './validation'

const isBreak = (department: string) => (BREAK_DEPARTMENTS as readonly string[]).includes(department)

/** The default office as it was saved before break areas existed. */
const v1Default = (): OfficeLayout => {
  const l = createDefaultLayout()
  const ids = new Set(l.rooms.filter((r) => isBreak(r.department)).map((r) => r.id))
  return { ...l, rooms: l.rooms.filter((r) => !ids.has(r.id)), furniture: l.furniture.filter((f) => !f.roomId || !ids.has(f.roomId)) }
}

const room = (id: string, x: number, z: number, width: number, depth: number): Room =>
  ({ id, name: id, department: 'executive', x, z, width, depth, wallHeight: 2.5, color: '#999999', rotation: 0 })
const desk = (id: string, x: number, z: number): Furniture => ({ id, type: 'desk', x, z, rotation: 0, roomId: null })

const smallOffice = (): OfficeLayout => ({
  schemaVersion: 2,
  office: { width: 25, depth: 20, gridSize: 0.25 },
  rooms: [room('room-ceo-office', -9.75, -8.2, 5.5, 3.6)],
  furniture: [desk('desk-01', -10, -8.5), desk('desk-02', -8.5, -8.5)],
})

const breakRooms = (l: OfficeLayout) => l.rooms.filter((r) => isBreak(r.department))
const centres = (l: OfficeLayout) => Object.fromEntries(breakRooms(l).map((r) => [r.department, [r.x, r.z]]))

describe('the full set', () => {
  const { rooms, furniture } = breakAreaItems()

  it('every piece of furniture is inside its room', () => {
    for (const f of furniture) {
      const r = roomRect(rooms.find((x) => x.id === f.roomId)!)
      const fr = furnitureRect(f)
      expect([f.id, fr.minX >= r.minX - 1e-6, fr.maxX <= r.maxX + 1e-6, fr.minZ >= r.minZ - 1e-6, fr.maxZ <= r.maxZ + 1e-6]).toEqual([f.id, true, true, true, true])
    }
  })

  it('chairs face their table, west chairs rotation 270 and east chairs 90', () => {
    const tables = furniture.filter((f) => f.type === 'dining-table')
    const chairs = furniture.filter((f) => f.type === 'dining-chair')
    expect(chairs).toHaveLength(16)
    for (const c of chairs) {
      const facing = rotateOffset(0, -1, c.rotation)
      const table = tables.reduce((a, b) => (Math.abs(a.z - c.z) < Math.abs(b.z - c.z) ? a : b))
      expect(c.rotation).toBe(c.x < table.x ? 270 : 90)
      expect(Math.sign(table.x - c.x)).toBe(facing.dx)
    }
  })

  it('the default layout has no placement warnings', () => {
    expect([...findIssues(createDefaultLayout())]).toEqual([])
  })

  it('every break room keeps its open south side clear of other rooms and furniture', () => {
    const l = createDefaultLayout()
    for (const r of breakRooms(l)) {
      const rect = roomRect(r)
      const strip = { minX: rect.minX, maxX: rect.maxX, minZ: rect.maxZ, maxZ: rect.maxZ + 1 }
      expect(rectInsideOffice(strip, l.office)).toBe(true)
      const blockers = [...l.rooms.filter((o) => o.id !== r.id).map((o) => [o.id, roomRect(o)] as const), ...l.furniture.map((f) => [f.id, furnitureRect(f)] as const)]
      expect(blockers.filter(([, b]) => rectsOverlap(strip, b)).map(([id]) => id)).toEqual([])
    }
  })

  it('there are at least as many dining chairs and prayer mats as default desks', () => {
    const l = createDefaultLayout()
    const count = (t: string) => l.furniture.filter((f) => f.type === t).length
    expect(count('dining-chair')).toBeGreaterThanOrEqual(count('desk'))
    expect(count('prayer-mat')).toBeGreaterThanOrEqual(count('desk'))
    expect([l.rooms.length, l.furniture.length]).toEqual([13, 97])
  })
})

describe('withBreakAreasIfTheyFit', () => {
  it('an office with 6 or more desks and free default spots gets the full set', () => {
    const before = v1Default()
    const after = withBreakAreasIfTheyFit(before)
    const full = breakAreaItems()
    expect(after.rooms.slice(before.rooms.length)).toEqual(full.rooms)
    expect(after.furniture.slice(before.furniture.length)).toEqual(full.furniture)
    expect(after.rooms.slice(0, before.rooms.length)).toEqual(before.rooms)
    expect(after.furniture.slice(0, before.furniture.length)).toEqual(before.furniture)
    expect(JSON.stringify(after)).toBe(JSON.stringify(createDefaultLayout()))
  })

  it('a two-desk office gets the compact set in a row beside its room', () => {
    const after = withBreakAreasIfTheyFit(smallOffice())
    expect(centres(after)).toEqual({ kitchen: [-5.45, -8.8], dining: [-2.6, -8.8], prayer: [0.25, -8.8] })
    expect(after.rooms.slice(1).map((r) => r.id)).toEqual(['room-kitchen', 'room-dining', 'room-prayer'])
    expect(after.furniture.filter((f) => f.type === 'dining-chair')).toHaveLength(4)
    expect(after.furniture.filter((f) => f.type === 'prayer-mat')).toHaveLength(4)
    expect(after.rooms.every((r) => roomRect(r).minZ >= -10 - 1e-9)).toBe(true)
    expect(after.rooms.slice(1).map((r) => roomRect(r).minZ)).toEqual([-10, -10, -10])
  })

  it('a large office with something on a default spot gets the compact set, and nothing moves', () => {
    const before = v1Default()
    before.furniture.push({ id: 'plant-extra', type: 'plant', x: 0.3, z: 5.2, rotation: 0, roomId: null })
    const after = withBreakAreasIfTheyFit(before)
    expect(breakRooms(after)).toHaveLength(3)
    expect(breakRooms(after).every((r) => r.width === 2.6 && r.depth === 2.4)).toBe(true)
    expect(after.rooms.slice(0, before.rooms.length)).toEqual(before.rooms)
    expect(after.furniture.slice(0, before.furniture.length)).toEqual(before.furniture)
    expect(after.furniture.filter((f) => f.type === 'dining-chair')).toHaveLength(4)
  })

  it('compact furniture stays inside its room with no placement warnings, and chairs face the table', () => {
    for (const d of BREAK_DEPARTMENTS) {
      const { room: r, furniture } = compactBreakArea(d)
      expect(r).toMatchObject({ x: 0, z: 0, width: 2.6, depth: 2.4, department: d })
      const rect = roomRect(r)
      for (const f of furniture) {
        const fr = furnitureRect(f)
        expect([f.id, fr.minX >= rect.minX, fr.maxX <= rect.maxX, fr.minZ >= rect.minZ, fr.maxZ <= rect.maxZ]).toEqual([f.id, true, true, true, true])
        expect(f.roomId).toBe(r.id)
      }
    }
    for (const c of compactBreakArea('dining').furniture.filter((f) => f.type === 'dining-chair')) {
      expect(rotateOffset(0, -1, c.rotation).dz).toBe(Math.sign(0 - c.z))
    }
    const after = withBreakAreasIfTheyFit(smallOffice())
    expect([...findIssues(after)]).toEqual([])
  })

  it('returns fresh objects each time', () => {
    expect(compactBreakArea('kitchen').room).not.toBe(compactBreakArea('kitchen').room)
    expect(breakAreaItems().rooms[0]).not.toBe(breakAreaItems().rooms[0])
  })

  it('adds nothing and returns the same object when there is no room for all three', () => {
    const filled: OfficeLayout = { schemaVersion: 2, office: { width: 10, depth: 10, gridSize: 0.25 }, rooms: [room('room-a', -2.5, -2.5, 5, 5), room('room-b', 2.5, -2.5, 5, 5), room('room-c', -2.5, 2.5, 5, 5), room('room-d', 2.5, 2.5, 5, 5)], furniture: [] }
    expect(withBreakAreasIfTheyFit(filled)).toBe(filled)
    const tiny: OfficeLayout = { schemaVersion: 2, office: { width: 6, depth: 6, gridSize: 0.25 }, rooms: [room('room-a', 0, 0, 5, 5)], furniture: [] }
    expect(withBreakAreasIfTheyFit(tiny)).toBe(tiny)
  })

  it('does not add one or two rooms when only some fit', () => {
    // Space for exactly one compact room (plus its south strip) beside the existing room.
    const l: OfficeLayout = { schemaVersion: 2, office: { width: 9, depth: 5, gridSize: 0.25 }, rooms: [room('room-a', -2.5, -1.4, 4, 2.2)], furniture: [] }
    expect(findRoomSpot(l, 2.6, 2.4)).not.toBeNull()
    expect(withBreakAreasIfTheyFit(l)).toBe(l)
  })

  it('adds nothing if an ID is taken, or a break room already exists', () => {
    const taken = smallOffice()
    taken.furniture.push({ id: 'prayer-mat-03', type: 'plant', x: 5, z: 5, rotation: 0, roomId: null })
    expect(withBreakAreasIfTheyFit(taken)).toBe(taken)
    const roomTaken = smallOffice()
    roomTaken.rooms.push({ ...room('room-kitchen', 8, 8, 2, 2) })
    expect(withBreakAreasIfTheyFit(roomTaken)).toBe(roomTaken)
    const existing = smallOffice()
    existing.rooms.push({ ...room('my-kitchen', 8, 8, 2, 2), department: 'kitchen' })
    expect(withBreakAreasIfTheyFit(existing)).toBe(existing)
  })

  it('is deterministic', () => {
    expect(JSON.stringify(withBreakAreasIfTheyFit(smallOffice()))).toBe(JSON.stringify(withBreakAreasIfTheyFit(smallOffice())))
  })
})

describe('findRoomSpot', () => {
  it('does not change the layout it is given', () => {
    const l = smallOffice()
    const copy = JSON.stringify(l)
    findRoomSpot(l, 2.6, 2.4)
    expect(JSON.stringify(l)).toBe(copy)
  })

  it('goes beside the newest room first, then scans the floor', () => {
    expect(findRoomSpot(smallOffice(), 2.6, 2.4)).toEqual({ x: -5.45, z: -8.8 })
    const l = smallOffice()
    l.rooms = [room('room-a', 0, 0, 25, 3)]
    expect(findRoomSpot(l, 2.6, 2.4)).not.toBeNull()
  })

  it('returns null for a room bigger than the floor, and copes with a huge floor', () => {
    expect(findRoomSpot(smallOffice(), 30, 2)).toBeNull()
    const huge: OfficeLayout = { ...smallOffice(), office: { width: 1e9, depth: 1e9, gridSize: 0.25 }, rooms: [], furniture: [] }
    expect(() => findRoomSpot(huge, 2.6, 2.4)).not.toThrow()
  })

  it('keeps a clear strip south of the new room', () => {
    const l = smallOffice()
    l.furniture.push(desk('desk-blocker', -5.45, -6.9))
    const spot = findRoomSpot(l, 2.6, 2.4)
    expect(spot).not.toEqual({ x: -5.45, z: -8.8 })
  })

  it('never opens a new room onto the south wall of the floor', () => {
    const l: OfficeLayout = { ...smallOffice(), office: { width: 8, depth: 2.4, gridSize: 0.25 }, rooms: [], furniture: [] }
    expect(findRoomSpot(l, 2.6, 2.4)).toBeNull()
  })

  it.each([0, 90, 180, 270] as const)('does not build in front of a room turned %i degrees', (rotation) => {
    const existing = { ...room('room-a', 2, 2, 6, 6), rotation }
    const l: OfficeLayout = { ...smallOffice(), office: { width: 40, depth: 40, gridSize: 0.25 }, rooms: [existing], furniture: [] }
    const spot = findRoomSpot(l, 2.6, 2.4)!
    const open = rotateOffset(0, 1, rotation)
    const edge = roomRect(existing)
    const front = {
      minX: open.dx > 0 ? edge.maxX : open.dx < 0 ? edge.minX - 1 : edge.minX,
      maxX: open.dx > 0 ? edge.maxX + 1 : open.dx < 0 ? edge.minX : edge.maxX,
      minZ: open.dz > 0 ? edge.maxZ : open.dz < 0 ? edge.minZ - 1 : edge.minZ,
      maxZ: open.dz > 0 ? edge.maxZ + 1 : open.dz < 0 ? edge.minZ : edge.maxZ,
    }
    expect(rectsOverlap({ minX: spot.x - 1.3, maxX: spot.x + 1.3, minZ: spot.z - 1.2, maxZ: spot.z + 1.2 }, front)).toBe(false)
  })
})

describe('the default placement', () => {
  it('no break room stands in the clear metre in front of another room, including the meeting room', () => {
    const l = createDefaultLayout()
    for (const r of l.rooms) {
      const e = roomRect(r)
      const front = { minX: e.minX, maxX: e.maxX, minZ: e.maxZ, maxZ: e.maxZ + 1 }
      expect([r.id, l.rooms.filter((o) => isBreak(o.department) && o.id !== r.id && rectsOverlap(front, roomRect(o))).map((o) => o.id)]).toEqual([r.id, []])
    }
  })
})
