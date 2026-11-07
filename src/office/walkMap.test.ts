import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { furnitureRect, roomRect, rotateOffset, type Rect } from '../layout/geometry'
import { seatForDesk } from '../layout/seats'
import type { Furniture, OfficeLayout, Room, Rotation } from '../layout/types'
import { breakSpots } from './breakSpots'
import { ownerOffice } from './layoutFixtures'
import { createWalkMap, pointAlong, routeLength, type Point } from './walkMap'

const BLOCKING = ['desk', 'meeting-table', 'dining-table', 'kitchen-counter', 'storage-cabinet', 'shelf', 'plant']

/** The walls and furniture as the test sees them, worked out independently of the walk map. */
function obstacles(layout: OfficeLayout): Rect[] {
  const rects: Rect[] = layout.furniture.filter((f) => BLOCKING.includes(f.type)).map(furnitureRect)
  for (const room of layout.rooms) {
    const lw = room.rotation % 180 === 0 ? room.width : room.depth
    const ld = room.rotation % 180 === 0 ? room.depth : room.width
    const boxes = [
      [-lw / 2, -lw / 2 + 0.04, -ld / 2, ld / 2],
      [lw / 2 - 0.04, lw / 2, -ld / 2, ld / 2],
      [-lw / 2, lw / 2, -ld / 2, -ld / 2 + 0.04],
    ]
    for (const [x0, x1, z0, z1] of boxes) {
      const corners = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]].map(([x, z]) => rotateOffset(x, z, room.rotation))
      rects.push({ minX: room.x + Math.min(...corners.map((c) => c.dx)), maxX: room.x + Math.max(...corners.map((c) => c.dx)), minZ: room.z + Math.min(...corners.map((c) => c.dz)), maxZ: room.z + Math.max(...corners.map((c) => c.dz)) })
    }
  }
  return rects
}

const inside = (r: Rect, p: Point, margin = 0.005) => p.x > r.minX + margin && p.x < r.maxX - margin && p.z > r.minZ + margin && p.z < r.maxZ - margin

function expectClear(layout: OfficeLayout, route: Point[]) {
  const blocks = obstacles(layout)
  const total = routeLength(route)
  const hits: string[] = []
  for (let m = 0; m <= total; m += 0.05) {
    const p = pointAlong(route, m)
    if (blocks.some((r) => inside(r, p))) hits.push(`at ${m.toFixed(2)} m, (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`)
  }
  expect(hits).toEqual([])
}

const seats = (layout: OfficeLayout) => layout.furniture.filter((f) => f.type === 'desk').map((d) => seatForDesk(layout, d))

describe('createWalkMap', () => {
  it('every default desk can reach all three break areas, including through the narrow gaps', () => {
    const layout = createDefaultLayout()
    const map = createWalkMap(layout)
    const spots = breakSpots(layout)
    for (const seat of seats(layout)) {
      for (const list of [spots.coffee, spots.dining, spots.prayer]) {
        for (const spot of [list[0], list[list.length - 1]]) {
          const route = map.route(seat, spot)
          expect(route, `from (${seat.x}, ${seat.z}) to (${spot.x}, ${spot.z})`).not.toBeNull()
          expectClear(layout, route!)
        }
      }
    }
  })

  it('every desk in a two-desk office with the compact row can reach all three', () => {
    const layout = ownerOffice()
    expect(layout.rooms.map((r) => r.department).sort()).toEqual(['dining', 'executive', 'kitchen', 'prayer'])
    const map = createWalkMap(layout)
    const spots = breakSpots(layout)
    // The two chairs on the far side of the compact dining table sit in a 0.18 m gap nobody can walk through, so they have no route.
    const reachable = { coffee: 3, dining: 2, prayer: 4 }
    for (const seat of seats(layout)) {
      for (const kind of ['coffee', 'dining', 'prayer'] as const) {
        const found = spots[kind].filter((spot) => map.route(seat, spot) !== null)
        expect(found, `${kind} from (${seat.x}, ${seat.z})`).toHaveLength(reachable[kind])
        for (const spot of found) {
          expectClear(layout, map.route(seat, spot)!)
          expectClear(layout, map.route(spot, seat)!)
          expect(map.regionOf(spot)).toBe(map.regionOf(seat))
        }
        for (const spot of spots[kind].filter((s) => !found.includes(s))) expect(map.regionOf(spot)).not.toBe(map.regionOf(seat))
      }
    }
  })

  it('never crosses a wall or a desk, sampled every 5 cm along many routes', () => {
    const layout = createDefaultLayout()
    const map = createWalkMap(layout)
    const points: Point[] = [...seats(layout), ...Object.values(breakSpots(layout)).flat(), { x: 0, z: 0 }, { x: 11, z: -8 }, { x: -11, z: 8 }]
    let routes = 0
    for (let i = 0; i < points.length; i += 2) {
      for (let j = 1; j < points.length; j += 3) {
        const route = map.route(points[i], points[j])
        if (!route) continue
        routes++
        expectClear(layout, route)
      }
    }
    expect(routes).toBeGreaterThan(30)
  })

  it.each([0, 90, 180, 270] as const)('enters a room turned %i degrees through its open side only', (rotation: Rotation) => {
    const room: Room = { id: 'r', name: 'R', department: 'executive', x: 0, z: 0, width: rotation % 180 === 0 ? 4 : 3, depth: rotation % 180 === 0 ? 3 : 4, wallHeight: 2.5, color: '#fff', rotation }
    const layout: OfficeLayout = { schemaVersion: 2, office: { width: 14, depth: 14, gridSize: 0.25 }, rooms: [room], furniture: [] }
    const map = createWalkMap(layout)
    const open = rotateOffset(0, 1, rotation)
    const rect = roomRect(room)
    const target = { x: 0, z: 0 }
    for (const start of [{ x: 5, z: 0 }, { x: -5, z: 0 }, { x: 0, z: 5 }, { x: 0, z: -5 }, { x: 4, z: 4 }, { x: -4, z: -4 }]) {
      const route = map.route(start, target)
      expect(route, `from ${start.x}, ${start.z}`).not.toBeNull()
      expectClear(layout, route!)
      // The first sample inside the footprint is where it came in: that must be on the open side.
      const total = routeLength(route!)
      let entry: Point | null = null
      for (let m = 0; m <= total && !entry; m += 0.02) {
        const p = pointAlong(route!, m)
        if (p.x > rect.minX && p.x < rect.maxX && p.z > rect.minZ && p.z < rect.maxZ) entry = p
      }
      expect(entry).not.toBeNull()
      const onOpenSide = open.dx !== 0 ? Math.abs(entry!.x - (open.dx > 0 ? rect.maxX : rect.minX)) < 0.1 : Math.abs(entry!.z - (open.dz > 0 ? rect.maxZ : rect.minZ)) < 0.1
      expect(onOpenSide, `entered at ${entry!.x.toFixed(2)}, ${entry!.z.toFixed(2)}`).toBe(true)
    }
  })

  it('gives null when a target is walled off', () => {
    const room: Room = { id: 'r', name: 'R', department: 'executive', x: 0, z: 0, width: 4, depth: 3, wallHeight: 2.5, color: '#fff', rotation: 0 }
    const row: Furniture[] = [-1.5, -0.75, 0, 0.75, 1.5].map((x, i) => ({ id: `s${i}`, type: 'storage-cabinet', x, z: 1.1, rotation: 0, roomId: 'r' }))
    const layout: OfficeLayout = { schemaVersion: 2, office: { width: 14, depth: 14, gridSize: 0.25 }, rooms: [room], furniture: row }
    expect(createWalkMap(layout).route({ x: 4, z: 4 }, { x: 0, z: 0 })).toBeNull()
    expect(createWalkMap({ ...layout, furniture: [] }).route({ x: 4, z: 4 }, { x: 0, z: 0 })).not.toBeNull()
  })

  it('gives null, and does not throw, for points off the floor or not numbers', () => {
    const map = createWalkMap(createDefaultLayout())
    expect(map.route({ x: 500, z: 500 }, { x: 0, z: 0 })).toBeNull()
    expect(map.route({ x: Number.NaN, z: 0 }, { x: 0, z: 0 })).toBeNull()
  })

  it('does not throw on an empty layout, a huge floor or a bad grid size', () => {
    const empty: OfficeLayout = { schemaVersion: 2, office: { width: 25, depth: 20, gridSize: 0.25 }, rooms: [], furniture: [] }
    expect(createWalkMap(empty).route({ x: -5, z: -5 }, { x: 5, z: 5 })).not.toBeNull()
    const huge: OfficeLayout = { ...empty, office: { width: 100000, depth: 100000, gridSize: 0.25 } }
    expect(() => createWalkMap(huge).route({ x: -40000, z: -40000 }, { x: 40000, z: 40000 })).not.toThrow()
    for (const gridSize of [0, -1, Number.NaN]) expect(() => createWalkMap({ ...empty, office: { ...empty.office, gridSize } }).route({ x: 0, z: 0 }, { x: 3, z: 3 })).not.toThrow()
  })

  it('the same inputs give the same route', () => {
    const layout = createDefaultLayout()
    const a = createWalkMap(layout).route({ x: -7.4, z: -3.84 }, { x: 3.2, z: 5 })
    const b = createWalkMap(structuredClone(layout)).route({ x: -7.4, z: -3.84 }, { x: 3.2, z: 5 })
    expect(a).toEqual(b)
    const map = createWalkMap(layout)
    expect(map.route({ x: -7.4, z: -3.84 }, { x: 3.2, z: 5 })).toBe(map.route({ x: -7.4, z: -3.84 }, { x: 3.2, z: 5 }))
  })

  it('builds the routes from every default desk to the three break areas within 500 ms', () => {
    const layout = createDefaultLayout()
    const start = performance.now()
    const map = createWalkMap(layout)
    const spots = breakSpots(layout)
    for (const seat of seats(layout)) for (const list of [spots.coffee, spots.dining, spots.prayer]) expect(map.route(seat, list[0])).not.toBeNull()
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('routeLength and pointAlong', () => {
  const route = [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: -4 }]
  it('measures the route', () => expect(routeLength(route)).toBe(7))
  it('walks along it with the rig heading: 0 faces -Z, positive turns toward -X', () => {
    expect(pointAlong(route, 0)).toMatchObject({ x: 0, z: 0, heading: 270 })
    expect(pointAlong(route, 1.5)).toMatchObject({ x: 1.5, z: 0, heading: 270 })
    expect(pointAlong(route, 5)).toMatchObject({ x: 3, z: -2, heading: 0 })
    expect(pointAlong(route, 99)).toMatchObject({ x: 3, z: -4 })
    expect(pointAlong(route, -5)).toMatchObject({ x: 0, z: 0 })
  })
  it('copes with a single point', () => {
    expect(pointAlong([{ x: 1, z: 2 }], 3)).toMatchObject({ x: 1, z: 2 })
    expect(routeLength([{ x: 1, z: 2 }])).toBe(0)
  })
})
