import { DEPARTMENTS, FURNITURE_SPECS } from './catalog'
import { createDefaultLayout } from './defaultLayout'
import { LAYOUT_SCHEMA_VERSION, type Furniture, type OfficeLayout, type OfficeSettings, type Room } from './types'

export const LAYOUT_STORAGE_KEY = 'ai-virtual-office:layout:v1'
export const LAYOUT_BACKUP_KEY = 'ai-virtual-office:layout:v1:backup'

type KV = Pick<Storage, 'getItem' | 'setItem'>
export type LoadProblem = 'missing' | 'corrupt' | 'unsupported-version' | 'unavailable'
export type LoadResult = { layout: OfficeLayout; savedJson: string | null; problem: LoadProblem | null }

const ROTATIONS = [0, 90, 180, 270]

/** JSON with a fixed key order per object, so equal layouts always serialize identically. */
export function serializeLayout(l: OfficeLayout): string {
  return JSON.stringify({
    schemaVersion: l.schemaVersion,
    office: { width: l.office.width, depth: l.office.depth, gridSize: l.office.gridSize },
    rooms: l.rooms.map((r) => ({ id: r.id, name: r.name, department: r.department, x: r.x, z: r.z, width: r.width, depth: r.depth, wallHeight: r.wallHeight, color: r.color })),
    furniture: l.furniture.map((f) => ({ id: f.id, type: f.type, x: f.x, z: f.z, rotation: f.rotation, roomId: f.roomId })),
  })
}

/** Upgrades older saved shapes to the current schema. v1 is current, so it passes through. */
export function migrateLayout(raw: unknown): unknown {
  return raw
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPositive = (v: unknown): v is number => isFinite(v) && v > 0
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function parseOffice(v: unknown): OfficeSettings | null {
  if (!isObject(v) || !isPositive(v.width) || !isPositive(v.depth) || !isPositive(v.gridSize)) return null
  return { width: v.width, depth: v.depth, gridSize: v.gridSize }
}

function parseRoom(v: unknown): Room | null {
  if (!isObject(v) || !isText(v.id) || typeof v.name !== 'string' || typeof v.department !== 'string' || !(v.department in DEPARTMENTS)) return null
  if (!isFinite(v.x) || !isFinite(v.z) || !isPositive(v.width) || !isPositive(v.depth) || !isPositive(v.wallHeight) || !isText(v.color)) return null
  return { id: v.id, name: v.name, department: v.department as Room['department'], x: v.x, z: v.z, width: v.width, depth: v.depth, wallHeight: v.wallHeight, color: v.color }
}

function parseFurniture(v: unknown): Furniture | null {
  if (!isObject(v) || !isText(v.id) || typeof v.type !== 'string' || !(v.type in FURNITURE_SPECS)) return null
  if (!isFinite(v.x) || !isFinite(v.z) || !ROTATIONS.includes(v.rotation as number) || !(v.roomId === null || isText(v.roomId))) return null
  return { id: v.id, type: v.type as Furniture['type'], x: v.x, z: v.z, rotation: v.rotation as Furniture['rotation'], roomId: v.roomId as string | null }
}

/** Strict structural check. Anything invalid rejects the whole layout rather than silently dropping parts of it. */
export function parseLayout(raw: unknown): OfficeLayout | null {
  if (!isObject(raw) || raw.schemaVersion !== LAYOUT_SCHEMA_VERSION || !Array.isArray(raw.rooms) || !Array.isArray(raw.furniture)) return null
  const office = parseOffice(raw.office)
  const rooms = raw.rooms.map(parseRoom)
  const furniture = raw.furniture.map(parseFurniture)
  if (!office || rooms.some((r) => !r) || furniture.some((f) => !f)) return null
  const validRooms = rooms as Room[]
  const validFurniture = furniture as Furniture[]
  const ids = [...validRooms, ...validFurniture].map((o) => o.id)
  if (new Set(ids).size !== ids.length) return null
  const roomIds = new Set(validRooms.map((r) => r.id))
  if (validFurniture.some((f) => f.roomId !== null && !roomIds.has(f.roomId))) return null
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, office, rooms: validRooms, furniture: validFurniture }
}

function readStored(json: string): OfficeLayout | null {
  try {
    return parseLayout(migrateLayout(JSON.parse(json)))
  } catch {
    return null
  }
}

export function loadLayout(storage: KV | null): LoadResult {
  const fallback = (problem: LoadProblem): LoadResult => ({ layout: createDefaultLayout(), savedJson: null, problem })
  if (!storage) return fallback('unavailable')
  let json: string | null
  try {
    json = storage.getItem(LAYOUT_STORAGE_KEY)
  } catch {
    return fallback('unavailable')
  }
  if (json === null) return fallback('missing')
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return fallback('corrupt')
  }
  if (isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > LAYOUT_SCHEMA_VERSION) return fallback('unsupported-version')
  const layout = parseLayout(migrateLayout(raw))
  return layout ? { layout, savedJson: json, problem: null } : fallback('corrupt')
}

export function saveLayout(storage: KV | null, l: OfficeLayout): { ok: true; json: string } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: 'Browser storage is not available.' }
  const json = serializeLayout(l)
  if (!readStored(json)) return { ok: false, error: 'The layout failed validation and was not saved.' }
  try {
    const current = storage.getItem(LAYOUT_STORAGE_KEY)
    // Keep a copy of a saved value we could not read, so a newer or damaged layout is never lost silently.
    if (current !== null && !readStored(current) && storage.getItem(LAYOUT_BACKUP_KEY) === null) storage.setItem(LAYOUT_BACKUP_KEY, current)
    storage.setItem(LAYOUT_STORAGE_KEY, json)
    return { ok: true, json }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Saving failed.' }
  }
}

export function getBrowserStorage(): KV | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
