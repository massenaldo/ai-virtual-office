import { BREAK_DEPARTMENTS, DEFAULT_WALL_HEIGHT, DEPARTMENTS, type BreakDepartment } from './catalog'
import { clampFurniture, clampRoom, furnitureRect, rectInsideOffice, rectsOverlap, roomRect, rotateOffset, type Rect } from './geometry'
import { LAYOUT_SCHEMA_VERSION, type Furniture, type FurnitureType, type OfficeLayout, type Room, type Rotation } from './types'

// The kitchen, the dining area and the prayer room. This module owns where they go, so the default layout, the
// upgrade of a saved layout and the editor's "Add break areas" all agree. Everything here is pure.

type BreakSet = { rooms: Room[]; furniture: Furniture[] }

const pad = (n: number) => String(n).padStart(2, '0')
const round3 = (n: number) => Math.round(n * 1000) / 1000

const ROOM_INFO: Record<BreakDepartment, { id: string; name: string }> = {
  kitchen: { id: 'room-kitchen', name: 'KITCHEN' },
  dining: { id: 'room-dining', name: 'DINING AREA' },
  prayer: { id: 'room-prayer', name: 'PRAYER ROOM' },
}

const makeRoom = (department: BreakDepartment, x: number, z: number, width: number, depth: number): Room =>
  ({ id: ROOM_INFO[department].id, name: ROOM_INFO[department].name, department, x, z, width, depth, wallHeight: DEFAULT_WALL_HEIGHT, color: DEPARTMENTS[department].color, rotation: 0 })

const piece = (id: string, type: FurnitureType, x: number, z: number, rotation: Rotation, department: BreakDepartment): Furniture =>
  ({ id, type, x, z, rotation, roomId: ROOM_INFO[department].id })

/** The full set at its default placement, for an office the size of the default one. */
export function breakAreaItems(): BreakSet {
  const rooms = [makeRoom('prayer', -4.0, 6.8, 3.6, 3.6), makeRoom('kitchen', 0.3, 5.2, 2.6, 3.4), makeRoom('dining', 3.2, 5.8, 2.8, 4.6)]
  const furniture: Furniture[] = [
    piece('kitchen-counter-01', 'kitchen-counter', 0.3, 3.92, 0, 'kitchen'),
    piece('coffee-machine-01', 'coffee-machine', -0.4, 3.92, 0, 'kitchen'),
  ]
  const tableZ = [4.75, 6.95]
  tableZ.forEach((z, i) => furniture.push(piece(`dining-table-${pad(i + 1)}`, 'dining-table', 3.2, z, 90, 'dining')))
  let chair = 0
  for (const z of tableZ) {
    for (const [x, rotation] of [[2.58, 270], [3.82, 90]] as const) {
      for (const dz of [-0.75, -0.25, 0.25, 0.75]) furniture.push(piece(`dining-chair-${pad(++chair)}`, 'dining-chair', x, round3(z + dz), rotation, 'dining'))
    }
  }
  let mat = 0
  for (const z of [5.48, 6.14, 6.8, 7.46, 8.12]) {
    for (const x of [-5.15, -4.0, -2.85]) furniture.push(piece(`prayer-mat-${pad(++mat)}`, 'prayer-mat', x, z, 90, 'prayer'))
  }
  return { rooms, furniture }
}

/** One compact room with its furniture, centred on the origin. The caller moves it by an offset. */
export function compactBreakArea(department: BreakDepartment): { room: Room; furniture: Furniture[] } {
  const room = makeRoom(department, 0, 0, 2.6, 2.4)
  const furniture: Furniture[] = []
  if (department === 'kitchen') {
    furniture.push(piece('kitchen-counter-01', 'kitchen-counter', 0, -0.78, 0, department), piece('coffee-machine-01', 'coffee-machine', -0.7, -0.78, 0, department))
  } else if (department === 'dining') {
    furniture.push(
      piece('dining-table-01', 'dining-table', 0, 0, 0, department),
      piece('dining-chair-01', 'dining-chair', -0.5, -0.62, 180, department),
      piece('dining-chair-02', 'dining-chair', 0.5, -0.62, 180, department),
      piece('dining-chair-03', 'dining-chair', -0.5, 0.62, 0, department),
      piece('dining-chair-04', 'dining-chair', 0.5, 0.62, 0, department),
    )
  } else {
    let mat = 0
    for (const z of [-0.4, 0.4]) for (const x of [-0.6, 0.6]) furniture.push(piece(`prayer-mat-${pad(++mat)}`, 'prayer-mat', x, z, 90, department))
  }
  return { room, furniture }
}

const GAP = 0.25
const STRIP = 1
const SCAN_STEP = 0.5
/** Bounds the scan, so an absurdly large saved floor can't make loading hang. */
const MAX_SCAN_CELLS = 100_000

const expand = (r: Rect, by: number): Rect => ({ minX: r.minX - by, maxX: r.maxX + by, minZ: r.minZ - by, maxZ: r.maxZ + by })

/** The strip of floor in front of a room's open side, which faces south until the room is turned. */
function frontStrip(room: Room): Rect {
  const r = roomRect(room)
  const { dx, dz } = rotateOffset(0, 1, room.rotation)
  if (dx > 0) return { ...r, minX: r.maxX, maxX: r.maxX + STRIP }
  if (dx < 0) return { ...r, minX: r.minX - STRIP, maxX: r.minX }
  if (dz > 0) return { ...r, minZ: r.maxZ, maxZ: r.maxZ + STRIP }
  return { ...r, minZ: r.minZ - STRIP, maxZ: r.minZ }
}

/**
 * The centre of a room of this size that fits on the floor, 0.25 m clear of everything, not in front of another room's
 * open side, and with a free 1 m strip on the floor in front of its own. First tries the sides of existing rooms, newest
 * first, then scans the floor.
 */
export function findRoomSpot(layout: OfficeLayout, width: number, depth: number): { x: number; z: number } | null {
  const obstacles = [...layout.rooms.map(roomRect), ...layout.furniture.map(furnitureRect)]
  const fronts = layout.rooms.map(frontStrip)
  const fits = (x: number, z: number): boolean => {
    const rect: Rect = { minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2 }
    if (!rectInsideOffice(rect, layout.office)) return false
    const padded = expand(rect, GAP)
    const strip: Rect = { minX: rect.minX, maxX: rect.maxX, minZ: rect.maxZ, maxZ: rect.maxZ + STRIP }
    if (!rectInsideOffice(strip, layout.office)) return false
    return !obstacles.some((o) => rectsOverlap(padded, o) || rectsOverlap(strip, o)) && !fronts.some((f) => rectsOverlap(rect, f))
  }

  for (let i = layout.rooms.length - 1; i >= 0; i--) {
    const r = roomRect(layout.rooms[i])
    const northZ = r.minZ + depth / 2
    const candidates = [
      { x: r.maxX + GAP + width / 2, z: northZ },
      { x: r.minX - GAP - width / 2, z: northZ },
      { x: r.minX + width / 2, z: r.maxZ + STRIP + GAP + depth / 2 },
    ]
    for (const c of candidates) {
      const x = round3(c.x)
      const z = round3(c.z)
      if (fits(x, z)) return { x, z }
    }
  }

  const x0 = -layout.office.width / 2 + width / 2
  const z0 = -layout.office.depth / 2 + depth / 2
  const cols = Math.floor((layout.office.width - width) / SCAN_STEP + 1e-6) + 1
  const rows = Math.floor((layout.office.depth - depth) / SCAN_STEP + 1e-6) + 1
  if (cols < 1 || rows < 1 || cols * rows > MAX_SCAN_CELLS) return null
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = round3(x0 + col * SCAN_STEP)
      const z = round3(z0 + row * SCAN_STEP)
      if (fits(x, z)) return { x, z }
    }
  }
  return null
}

const FULL_SET_MIN_DESKS = 6
const COMPACT_ORDER: BreakDepartment[] = ['kitchen', 'dining', 'prayer']

/**
 * Adds the three break rooms when they fit, never moving anything. All three or none; returns the same object when
 * nothing is added. The full set suits an office the size of the default one, a small office gets a compact set beside its rooms.
 */
export function withBreakAreasIfTheyFit(layout: OfficeLayout): OfficeLayout {
  if (layout.rooms.some((r) => (BREAK_DEPARTMENTS as readonly string[]).includes(r.department))) return layout
  const full = breakAreaItems()
  const taken = new Set([...layout.rooms, ...layout.furniture].map((o) => o.id))
  if ([...full.rooms, ...full.furniture].some((o) => taken.has(o.id))) return layout

  const desks = layout.furniture.filter((f) => f.type === 'desk').length
  const existing = [...layout.rooms.map(roomRect), ...layout.furniture.map(furnitureRect)]
  const fullFits = full.rooms.every((room) => {
    const rect = roomRect(room)
    return rectInsideOffice(rect, layout.office) && !existing.some((o) => rectsOverlap(rect, o))
  })
  if (desks >= FULL_SET_MIN_DESKS && fullFits) {
    return { ...layout, schemaVersion: LAYOUT_SCHEMA_VERSION, rooms: [...layout.rooms, ...full.rooms], furniture: [...layout.furniture, ...full.furniture] }
  }

  let next = layout
  for (const department of COMPACT_ORDER) {
    const { room, furniture } = compactBreakArea(department)
    const spot = findRoomSpot(next, room.width, room.depth)
    if (!spot) return layout
    next = {
      ...next,
      rooms: [...next.rooms, { ...room, x: spot.x, z: spot.z }],
      furniture: [...next.furniture, ...furniture.map((f) => ({ ...f, x: round3(f.x + spot.x), z: round3(f.z + spot.z) }))],
    }
  }
  return next
}

/** The break departments this office has no room for, in the order kitchen, dining, prayer. */
export function missingBreakDepartments(layout: OfficeLayout): BreakDepartment[] {
  return BREAK_DEPARTMENTS.filter((d) => !layout.rooms.some((r) => r.department === d))
}

const NOTICE_NAME: Record<BreakDepartment, string> = { kitchen: 'kitchen', dining: 'dining area', prayer: 'prayer room' }

/** The notice for an office missing some break rooms, or null when it has them all. */
export function breakAreasNotice(layout: OfficeLayout): string | null {
  const names = missingBreakDepartments(layout).map((d) => NOTICE_NAME[d])
  if (names.length === 0) return null
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
  return `This office has no ${list}, so agents will stay at their desks for those breaks.`
}

/** The first of id, id-2, id-3 ... that is not taken. Deterministic. */
function freeId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id
  for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return `${id}-${n}`
}

/**
 * Adds the missing break rooms, compact, each at the first free spot or else the office centre clamped to the floor.
 * Never moves anything that exists. Pure, so a reducer may run it twice. Returns the same object when nothing is missing.
 */
export function addBreakAreas(layout: OfficeLayout): OfficeLayout {
  const missing = missingBreakDepartments(layout)
  if (missing.length === 0) return layout
  const taken = new Set([...layout.rooms, ...layout.furniture].map((o) => o.id))
  let next = layout
  for (const department of COMPACT_ORDER.filter((d) => missing.includes(d))) {
    const { room, furniture } = compactBreakArea(department)
    const spot = findRoomSpot(next, room.width, room.depth)
    const placed: Room = spot ? { ...room, x: spot.x, z: spot.z } : clampRoom({ ...room, x: 0, z: 0 }, layout.office)
    const roomId = freeId(room.id, taken)
    taken.add(roomId)
    const pieces = furniture.map((f) => {
      const id = freeId(f.id, taken)
      taken.add(id)
      return clampFurniture({ ...f, id, roomId, x: round3(f.x + placed.x), z: round3(f.z + placed.z) }, layout.office)
    })
    next = { ...next, rooms: [...next.rooms, { ...placed, id: roomId }], furniture: [...next.furniture, ...pieces] }
  }
  return next
}

export const BREAK_NOTICE_DISMISSED_KEY = 'ai-virtual-office:break-areas-notice:dismissed'
type FlagStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Whether the person dismissed the notice in this browser. No storage, or storage that throws, means not dismissed. */
export function isBreakNoticeDismissed(storage: FlagStorage | null): boolean {
  try {
    return storage?.getItem(BREAK_NOTICE_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissBreakNotice(storage: FlagStorage | null): void {
  try {
    storage?.setItem(BREAK_NOTICE_DISMISSED_KEY, '1')
  } catch {
    // The notice is still hidden for this visit; it may come back next time.
  }
}
