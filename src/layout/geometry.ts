import { FURNITURE_SPECS, ROOM_LIMITS } from './catalog'
import type { Furniture, OfficeLayout, OfficeSettings, Room, Rotation } from './types'

export type Rect = { minX: number; maxX: number; minZ: number; maxZ: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

export function snap(value: number, grid: number): number {
  return round2(Math.round(value / grid) * grid)
}

/** Rotates a local offset the same way a group with rotation.y = degrees is rotated in three.js. */
export function rotateOffset(dx: number, dz: number, rotation: Rotation): { dx: number; dz: number } {
  switch (rotation) {
    case 90: return { dx: dz, dz: -dx }
    case 180: return { dx: -dx, dz: -dz }
    case 270: return { dx: -dz, dz: dx }
    default: return { dx, dz }
  }
}

export function nextRotation(r: Rotation): Rotation {
  return ((r + 90) % 360) as Rotation
}

const rectAround = (x: number, z: number, width: number, depth: number): Rect => ({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2 })

export function roomRect(room: Room): Rect {
  return rectAround(room.x, room.z, room.width, room.depth)
}

export function furnitureSize(item: Pick<Furniture, 'type' | 'rotation'>): { width: number; depth: number } {
  const spec = FURNITURE_SPECS[item.type]
  return item.rotation % 180 === 0 ? { width: spec.width, depth: spec.depth } : { width: spec.depth, depth: spec.width }
}

export function furnitureRect(item: Furniture): Rect {
  const { width, depth } = furnitureSize(item)
  return rectAround(item.x, item.z, width, depth)
}

export function rectsOverlap(a: Rect, b: Rect, epsilon = 0.01): boolean {
  return a.minX < b.maxX - epsilon && b.minX < a.maxX - epsilon && a.minZ < b.maxZ - epsilon && b.minZ < a.maxZ - epsilon
}

export function rectInsideOffice(r: Rect, office: OfficeSettings, epsilon = 0.001): boolean {
  return r.minX >= -office.width / 2 - epsilon && r.maxX <= office.width / 2 + epsilon && r.minZ >= -office.depth / 2 - epsilon && r.maxZ <= office.depth / 2 + epsilon
}

/** Smallest room whose footprint contains the point. */
export function roomAt(layout: OfficeLayout, x: number, z: number): string | null {
  let best: Room | null = null
  for (const room of layout.rooms) {
    const r = roomRect(room)
    if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue
    if (!best || room.width * room.depth < best.width * best.depth) best = room
  }
  return best?.id ?? null
}

const roundTo = (n: number, step: number) => Math.round(Math.round(n / step) * step * 1000) / 1000

// Bounds are rounded inward so rounding can never push a footprint past the office edge.
const clampCentre = (value: number, size: number, extent: number, step: number) => {
  const limit = Math.floor((extent / 2 - size / 2) / step + 1e-6) * step
  return clamp(roundTo(value, step), -limit, limit)
}

// Rooms keep their edges on the 1 cm grid: with a width in whole centimetres the centre needs half-centimetre steps,
// otherwise every resize would shift the "fixed" opposite edge by 5 mm.
const ROOM_CENTRE_STEP = 0.005
const FURNITURE_STEP = 0.01

export function clampRoom(next: Room, office: OfficeSettings, previous?: Room): Room {
  const width = round2(clamp(finiteOr(next.width, previous?.width ?? ROOM_LIMITS.minWidth), ROOM_LIMITS.minWidth, Math.min(ROOM_LIMITS.maxWidth, office.width)))
  const depth = round2(clamp(finiteOr(next.depth, previous?.depth ?? ROOM_LIMITS.minDepth), ROOM_LIMITS.minDepth, Math.min(ROOM_LIMITS.maxDepth, office.depth)))
  const x = clampCentre(finiteOr(next.x, previous?.x ?? 0), width, office.width, ROOM_CENTRE_STEP)
  const z = clampCentre(finiteOr(next.z, previous?.z ?? 0), depth, office.depth, ROOM_CENTRE_STEP)
  return { ...next, width, depth, x, z }
}

export function clampFurniture(next: Furniture, office: OfficeSettings, previous?: Furniture): Furniture {
  const { width, depth } = furnitureSize(next)
  const x = clampCentre(finiteOr(next.x, previous?.x ?? 0), width, office.width, FURNITURE_STEP)
  const z = clampCentre(finiteOr(next.z, previous?.z ?? 0), depth, office.depth, FURNITURE_STEP)
  return { ...next, x, z }
}
