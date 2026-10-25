import { snap } from '../layout/geometry'
import { resizeRoomEdge, updateFurniture, updateRoom, type Edge } from '../layout/operations'
import type { OfficeLayout, Selection } from '../layout/types'

/** What a pointer drag in the scene asks for, in world coordinates on the floor plane. */
export type TransformIntent =
  | { kind: 'move'; target: NonNullable<Selection>; x: number; z: number }
  | { kind: 'resize'; roomId: string; edge: Edge; coordinate: number }

const DRAG_THRESHOLD_PX = 4

/** Below this distance a press-and-release is a click (select), not a drag. */
export function pastDragThreshold(start: { x: number; y: number }, now: { x: number; y: number }): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= DRAG_THRESHOLD_PX
}

/** Applies a drag intent; grid is the snap step, or null when snapping is off. */
export function applyTransform(layout: OfficeLayout, intent: TransformIntent, grid: number | null): OfficeLayout {
  const s = (v: number) => (grid ? snap(v, grid) : v)
  if (intent.kind === 'resize') return resizeRoomEdge(layout, intent.roomId, intent.edge, s(intent.coordinate))
  const position = { x: s(intent.x), z: s(intent.z) }
  return intent.target.kind === 'room' ? updateRoom(layout, intent.target.id, position) : updateFurniture(layout, intent.target.id, position)
}
