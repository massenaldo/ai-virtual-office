import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import type { Room, Selection } from '../layout/types'
import { labelAnchor, screenPosition } from './labels'

/** Label elements by room id, shared between the DOM layer that owns them and the tracker that moves them. */
export type LabelRegistry = Map<string, HTMLDivElement>

const anchor = new THREE.Vector3()

/**
 * Room labels as plain DOM in one layer over the canvas. It sits outside R3F's event container, so label clicks
 * never reach the 3D scene, and it creates no extra React roots (drei's per-label roots could render empty).
 */
export function RoomLabelLayer({ rooms, editing, selection, registry, onSelect }: { rooms: Room[]; editing: boolean; selection: Selection; registry: LabelRegistry; onSelect(selection: Selection): void }) {
  return <div className="room-label-layer" aria-hidden={!editing}>
    {rooms.map((room) => {
      const selected = selection?.kind === 'room' && selection.id === room.id
      return <div key={room.id} ref={(el) => { if (el) registry.set(room.id, el); else registry.delete(room.id) }}
        className={`room-label${editing ? ' editable' : ''}${selected ? ' selected' : ''}`}
        onClick={editing ? () => onSelect({ kind: 'room', id: room.id }) : undefined}>{room.name}</div>
    })}
  </div>
}

/** Moves each label to its room's anchor on screen every frame, without React state updates. */
export function RoomLabelTracker({ rooms, floorPlan, registry }: { rooms: Room[]; floorPlan: boolean; registry: LabelRegistry }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  useFrame(() => {
    for (const room of rooms) {
      const el = registry.get(room.id)
      if (!el) continue
      const p = screenPosition(labelAnchor(room, floorPlan, anchor), camera, size)
      el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%)`
      el.style.visibility = p.visible ? 'visible' : 'hidden'
    }
  })
  return null
}
