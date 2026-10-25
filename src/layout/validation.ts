import { FURNITURE_SPECS } from './catalog'
import { furnitureRect, rectInsideOffice, rectsOverlap, roomRect } from './geometry'
import type { Furniture, FurnitureType, OfficeLayout } from './types'

export type Issue = { code: 'room-overlap' | 'furniture-overlap' | 'out-of-bounds'; otherId?: string; message: string }

// Pairs that are meant to share floor space: monitors sit on desks, chairs tuck under desks and meeting tables.
const TUCKS_UNDER: [FurnitureType, FurnitureType][] = [['chair', 'desk'], ['meeting-chair', 'meeting-table']]

function mayShareSpace(a: Furniture, b: Furniture): boolean {
  if (a.type === 'monitor' || b.type === 'monitor') return true
  return TUCKS_UNDER.some(([x, y]) => (a.type === x && b.type === y) || (a.type === y && b.type === x))
}

/** Placement warnings keyed by object id. Warnings never block editing or saving. */
export function findIssues(layout: OfficeLayout): Map<string, Issue[]> {
  const issues = new Map<string, Issue[]>()
  const add = (id: string, issue: Issue) => issues.set(id, [...(issues.get(id) ?? []), issue])
  const names = new Map(layout.rooms.map((r) => [r.id, r.name]))

  layout.rooms.forEach((room, i) => {
    const rect = roomRect(room)
    if (!rectInsideOffice(rect, layout.office)) add(room.id, { code: 'out-of-bounds', message: 'Room extends outside the office floor.' })
    for (const other of layout.rooms.slice(i + 1)) {
      if (!rectsOverlap(rect, roomRect(other))) continue
      add(room.id, { code: 'room-overlap', otherId: other.id, message: `Overlaps ${other.name}.` })
      add(other.id, { code: 'room-overlap', otherId: room.id, message: `Overlaps ${names.get(room.id)}.` })
    }
  })

  const rects = layout.furniture.map(furnitureRect)
  layout.furniture.forEach((item, i) => {
    if (!rectInsideOffice(rects[i], layout.office)) add(item.id, { code: 'out-of-bounds', message: 'Outside the office floor.' })
    for (let j = i + 1; j < layout.furniture.length; j++) {
      const other = layout.furniture[j]
      if (mayShareSpace(item, other) || !rectsOverlap(rects[i], rects[j])) continue
      add(item.id, { code: 'furniture-overlap', otherId: other.id, message: `Overlaps ${FURNITURE_SPECS[other.type].label.toLowerCase()} ${other.id}.` })
      add(other.id, { code: 'furniture-overlap', otherId: item.id, message: `Overlaps ${FURNITURE_SPECS[item.type].label.toLowerCase()} ${item.id}.` })
    }
  })
  return issues
}
