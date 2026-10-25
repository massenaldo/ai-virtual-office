import { useState } from 'react'
import { Html } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import type { Room, Selection } from '../layout/types'
import type { TransformIntent } from '../editor/transform'
import FootprintOutline from './FootprintOutline'
import { highlightFor } from './highlight'
import { useFloorDrag } from './useFloorDrag'

// Walls and ceilings never take clicks, so objects inside a room stay selectable from any angle.
const noRaycast = () => null

export type RoomMeshProps = {
  room: Room
  floorPlan: boolean
  editing: boolean
  selected: boolean
  invalid: boolean
  onSelect(): void
  onTransformStart(target: NonNullable<Selection>): void
  onTransform(intent: TransformIntent): void
  onTransformEnd(): void
}

export default function RoomMesh({ room, floorPlan, editing, selected, invalid, onSelect, onTransformStart, onTransform, onTransformEnd }: RoomMeshProps) {
  const [hovered, setHovered] = useState(false)
  const target = { kind: 'room' as const, id: room.id }
  const drag = useFloorDrag({
    enabled: editing,
    origin: () => ({ x: room.x, z: room.z }),
    onStart: () => onTransformStart(target),
    onMove: (p) => onTransform({ kind: 'move', target, x: p.x, z: p.z }),
    onEnd: onTransformEnd,
  })
  const h = room.wallHeight
  const highlight = highlightFor({ editing, selected, hovered, invalid })
  const pointer = editing ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect() },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : {}
  return <group position={[room.x, 0, room.z]}>
    <mesh receiveShadow position={[0, 0.015, 0]} {...pointer} {...drag}><boxGeometry args={[room.width, 0.04, room.depth]} /><meshStandardMaterial color={room.color} roughness={0.9} transparent opacity={floorPlan ? 0.95 : 0.45} /></mesh>
    {!floorPlan && <>
      {([-room.width / 2, room.width / 2] as const).map((x) => <mesh key={x} castShadow raycast={noRaycast} position={[x, h / 2, 0]}><boxGeometry args={[0.09, h, room.depth]} /><meshStandardMaterial color="#d4d8d9" roughness={0.3} metalness={0.1} /></mesh>)}
      <mesh castShadow raycast={noRaycast} position={[0, h / 2, -room.depth / 2]}><boxGeometry args={[room.width, h, 0.08]} /><meshStandardMaterial color="#d9e6e8" transparent opacity={0.38} roughness={0.18} metalness={0.15} /></mesh>
      <mesh castShadow raycast={noRaycast} position={[0, h - 0.02, 0]}><boxGeometry args={[room.width, 0.08, room.depth]} /><meshStandardMaterial color="#d2d4d2" roughness={0.5} /></mesh>
    </>}
    {highlight && <FootprintOutline width={room.width} depth={room.depth} color={highlight.color} lineWidth={highlight.width} y={0.05} />}
    <Html position={[0, floorPlan ? 0.3 : h + 0.22, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: editing ? 'auto' : 'none', whiteSpace: 'nowrap' }}>
      <div className={`room-label${editing ? ' editable' : ''}${selected ? ' selected' : ''}`} onClick={editing ? onSelect : undefined}>{room.name}</div>
    </Html>
  </group>
}
