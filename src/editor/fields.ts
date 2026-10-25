import { FURNITURE_SPECS } from '../layout/catalog'
import { furnitureInRoom } from '../layout/operations'
import type { OfficeLayout, Selection } from '../layout/types'

/** Accepts "4.5" or "4,5"; anything empty or non-finite is rejected so the field reverts. */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

export type DeletionPrompt = { needsConfirm: boolean; title: string; message: string }

/** Rooms that still contain furniture need confirmation, because their furniture is deleted with them. */
export function deletionPrompt(layout: OfficeLayout, selection: Selection): DeletionPrompt | null {
  if (!selection) return null
  if (selection.kind === 'furniture') {
    const item = layout.furniture.find((f) => f.id === selection.id)
    return item ? { needsConfirm: false, title: `Delete ${FURNITURE_SPECS[item.type].label.toLowerCase()}?`, message: '' } : null
  }
  const room = layout.rooms.find((r) => r.id === selection.id)
  if (!room) return null
  const count = furnitureInRoom(layout, room.id).length
  return {
    needsConfirm: count > 0,
    title: `Delete ${room.name}?`,
    message: `This also deletes the ${count} furniture items inside it. You can undo this.`,
  }
}
