import { DEPARTMENTS } from '../layout/catalog'
import type { DepartmentId, OfficeLayout } from '../layout/types'

export type DepartmentSummary = { id: DepartmentId; label: string; color: string; desks: number }

/** Sidebar and info-card numbers, derived from the layout so they always match the scene. */
export function summarizeLayout(layout: OfficeLayout): { departments: DepartmentSummary[]; roomCount: number; deskCount: number } {
  const desks = layout.furniture.filter((f) => f.type === 'desk')
  const departments = new Map<DepartmentId, DepartmentSummary>()
  for (const room of layout.rooms) {
    const entry = departments.get(room.department) ?? { id: room.department, label: DEPARTMENTS[room.department].label, color: room.color, desks: 0 }
    entry.desks += desks.filter((d) => d.roomId === room.id).length
    departments.set(room.department, entry)
  }
  return { departments: [...departments.values()], roomCount: layout.rooms.length, deskCount: desks.length }
}
