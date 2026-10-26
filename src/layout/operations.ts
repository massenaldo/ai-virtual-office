import { DEFAULT_WALL_HEIGHT, DEPARTMENTS, ROOM_LIMITS, ROOM_TEMPLATES, type RoomTemplateId } from './catalog'
import { clampFurniture, clampRoom, nextRotation, roomAt, rotateOffset } from './geometry'
import type { Furniture, FurnitureType, OfficeLayout, Room } from './types'

// Every operation returns a new layout, or the same reference when nothing changed so history can skip no-ops.

export type Edge = 'n' | 's' | 'e' | 'w'
type Point = { x: number; z: number }

const DUPLICATE_OFFSET = 0.5

function sameFields<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => a[k] === b[k])
}

function allIds(l: OfficeLayout): Set<string> {
  return new Set([...l.rooms.map((r) => r.id), ...l.furniture.map((f) => f.id)])
}

export function createId(prefix: string, taken: Set<string> = new Set()): string {
  let id: string
  do id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  while (taken.has(id))
  return id
}

export function furnitureInRoom(l: OfficeLayout, roomId: string): Furniture[] {
  return l.furniture.filter((f) => f.roomId === roomId)
}

export function addRoom(l: OfficeLayout, templateId: RoomTemplateId, at: Point = { x: 0, z: 0 }): { layout: OfficeLayout; id: string } {
  const template = ROOM_TEMPLATES.find((t) => t.id === templateId) ?? ROOM_TEMPLATES[0]
  const id = createId('room', allIds(l))
  const room = clampRoom({ id, name: template.label.toUpperCase(), department: template.department, x: at.x, z: at.z, width: template.width, depth: template.depth, wallHeight: DEFAULT_WALL_HEIGHT, color: DEPARTMENTS[template.department].color, rotation: 0 }, l.office)
  return { layout: { ...l, rooms: [...l.rooms, room] }, id }
}

function replaceRoom(l: OfficeLayout, prev: Room, next: Room, carryFurniture: boolean): OfficeLayout {
  if (sameFields(prev, next)) return l
  const dx = next.x - prev.x
  const dz = next.z - prev.z
  const furniture = carryFurniture && (dx !== 0 || dz !== 0)
    ? l.furniture.map((f) => (f.roomId === prev.id ? clampFurniture({ ...f, x: f.x + dx, z: f.z + dz }, l.office, f) : f))
    : l.furniture
  return { ...l, rooms: l.rooms.map((r) => (r.id === prev.id ? next : r)), furniture }
}

/** Clamped update; moving a room moves the furniture assigned to it by the same delta. */
export function updateRoom(l: OfficeLayout, id: string, patch: Partial<Omit<Room, 'id'>>): OfficeLayout {
  const prev = l.rooms.find((r) => r.id === id)
  if (!prev) return l
  const name = patch.name !== undefined && patch.name.trim() === '' ? prev.name : patch.name ?? prev.name
  return replaceRoom(l, prev, clampRoom({ ...prev, ...patch, id, name }, l.office, prev), true)
}

/** Moves one edge to `coordinate` while the opposite edge stays fixed. n/s are the -Z/+Z edges, w/e the -X/+X edges. */
export function resizeRoomEdge(l: OfficeLayout, id: string, edge: Edge, coordinate: number): OfficeLayout {
  const prev = l.rooms.find((r) => r.id === id)
  if (!prev || !Number.isFinite(coordinate)) return l
  const halfW = l.office.width / 2
  const halfD = l.office.depth / 2
  const limit = (size: number, min: number, max: number) => Math.min(max, Math.max(min, size))
  let { x, z, width, depth } = prev
  if (edge === 'e' || edge === 'w') {
    const west = prev.x - prev.width / 2
    const east = prev.x + prev.width / 2
    width = edge === 'e' ? limit(coordinate - west, ROOM_LIMITS.minWidth, Math.min(ROOM_LIMITS.maxWidth, halfW - west)) : limit(east - coordinate, ROOM_LIMITS.minWidth, Math.min(ROOM_LIMITS.maxWidth, east + halfW))
    x = edge === 'e' ? west + width / 2 : east - width / 2
  } else {
    const north = prev.z - prev.depth / 2
    const south = prev.z + prev.depth / 2
    depth = edge === 's' ? limit(coordinate - north, ROOM_LIMITS.minDepth, Math.min(ROOM_LIMITS.maxDepth, halfD - north)) : limit(south - coordinate, ROOM_LIMITS.minDepth, Math.min(ROOM_LIMITS.maxDepth, south + halfD))
    z = edge === 's' ? north + depth / 2 : south - depth / 2
  }
  return replaceRoom(l, prev, clampRoom({ ...prev, x, z, width, depth }, l.office, prev), false)
}

/**
 * Turns a room a quarter turn around its centre: the footprint swaps width and depth, the room slides back inside
 * the office if needed, and its furniture swings around the same centre and turns with it.
 */
export function rotateRoom(l: OfficeLayout, id: string): OfficeLayout {
  const prev = l.rooms.find((r) => r.id === id)
  if (!prev) return l
  const next = clampRoom({ ...prev, width: prev.depth, depth: prev.width, rotation: nextRotation(prev.rotation) }, l.office, prev)
  const furniture = l.furniture.map((f) => {
    if (f.roomId !== id) return f
    const o = rotateOffset(f.x - prev.x, f.z - prev.z, 90)
    return clampFurniture({ ...f, x: next.x + o.dx, z: next.z + o.dz, rotation: nextRotation(f.rotation) }, l.office, f)
  })
  return { ...l, rooms: l.rooms.map((r) => (r.id === id ? next : r)), furniture }
}

export function deleteRoom(l: OfficeLayout, id: string): OfficeLayout {
  if (!l.rooms.some((r) => r.id === id)) return l
  return { ...l, rooms: l.rooms.filter((r) => r.id !== id), furniture: l.furniture.filter((f) => f.roomId !== id) }
}

export function addFurniture(l: OfficeLayout, type: FurnitureType, at: Point): { layout: OfficeLayout; id: string } {
  const id = createId(type, allIds(l))
  const item = clampFurniture({ id, type, x: at.x, z: at.z, rotation: 0, roomId: null }, l.office)
  return { layout: { ...l, furniture: [...l.furniture, { ...item, roomId: roomAt(l, item.x, item.z) }] }, id }
}

/** Clamped update; the room assignment follows the new centre unless patch.roomId is given. */
export function updateFurniture(l: OfficeLayout, id: string, patch: Partial<Omit<Furniture, 'id' | 'type'>>): OfficeLayout {
  const prev = l.furniture.find((f) => f.id === id)
  if (!prev) return l
  const moved = clampFurniture({ ...prev, ...patch, id, type: prev.type }, l.office, prev)
  const requested = patch.roomId !== undefined ? patch.roomId : roomAt(l, moved.x, moved.z)
  const next = { ...moved, roomId: requested !== null && l.rooms.some((r) => r.id === requested) ? requested : null }
  if (sameFields(prev, next)) return l
  return { ...l, furniture: l.furniture.map((f) => (f.id === id ? next : f)) }
}

export function rotateFurniture(l: OfficeLayout, id: string): OfficeLayout {
  const prev = l.furniture.find((f) => f.id === id)
  return prev ? updateFurniture(l, id, { rotation: nextRotation(prev.rotation) }) : l
}

export function duplicateFurniture(l: OfficeLayout, id: string): { layout: OfficeLayout; id: string } {
  const prev = l.furniture.find((f) => f.id === id)
  if (!prev) return { layout: l, id }
  const added = addFurniture(l, prev.type, { x: prev.x + DUPLICATE_OFFSET, z: prev.z + DUPLICATE_OFFSET })
  return { layout: updateFurniture(added.layout, added.id, { rotation: prev.rotation }), id: added.id }
}

export function deleteFurniture(l: OfficeLayout, id: string): OfficeLayout {
  if (!l.furniture.some((f) => f.id === id)) return l
  return { ...l, furniture: l.furniture.filter((f) => f.id !== id) }
}
