import { useEffect, useMemo, useState } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { Room, Selection } from '../layout/types'
import type { TransformIntent } from '../editor/transform'
import { localSize, roomBaseboards, roomDetails, roomWalls, WALL_THICKNESS, type DetailKind } from './architecture'
import { floorFinishFor, partitionStyle, type PartitionStyle } from './finishes'
import FootprintOutline from './FootprintOutline'
import { highlightFor } from './highlight'
import { accentMaterial, floorMaterial, sharedMaterials } from './materials'
import { mergeBoxes } from './roomGeometry'
import { scaleFloorUvs } from './textures'
import { useFloorDrag } from './useFloorDrag'

// Walls, glass and trim never take clicks, so objects inside a room stay selectable from any angle.
const noRaycast = () => null

const FLOOR_THICKNESS = 0.02
const FLOOR_TOP = 0.025
const ACCENT_DEPTH = 0.06
const PLAN_BOUNDARY = '#56616b'

type MaterialName = 'wallPaint' | 'wallCap' | 'glass' | 'graphite' | 'baseboard' | 'whiteboard' | 'accent'
type MergedPart = { name: MaterialName; geometry: THREE.BufferGeometry; castShadow: boolean }

const GRAPHITE_DETAILS: DetailKind[] = ['art-frame', 'whiteboard-frame', 'whiteboard-tray']

/**
 * The room shell merged into one geometry per material, so a room costs a handful of draw calls however many
 * panes, mullions and trims it has. Solid walls are split into painted sides and a dark top (the cutaway cut colour).
 */
function mergedRoomParts(room: Room, style: PartitionStyle): MergedPart[] {
  const walls = roomWalls(room, style)
  const details = roomDetails(room, style)
  const detailBoxes = (kinds: DetailKind[]) => details.filter((d) => kinds.includes(d.kind)).map((d) => d.box)
  const parts: [MaterialName, THREE.BufferGeometry | null, boolean][] = [
    ['wallPaint', mergeBoxes(walls.solid, 'sides'), true],
    ['wallCap', mergeBoxes(walls.solid, 'top'), true],
    ['glass', mergeBoxes(walls.glass), false],
    ['graphite', mergeBoxes([...walls.frames, ...detailBoxes(GRAPHITE_DETAILS)]), false],
    ['baseboard', mergeBoxes(roomBaseboards(room, style)), false],
    ['whiteboard', mergeBoxes(detailBoxes(['whiteboard'])), false],
    ['accent', mergeBoxes(detailBoxes(['art-canvas'])), false],
  ]
  return parts.flatMap(([name, geometry, castShadow]) => (geometry ? [{ name, geometry, castShadow }] : []))
}

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
  const finish = floorFinishFor(room.department)
  // The shell is built in the room's own frame (local size) and turned by its rotation; outlines stay on the world footprint.
  const local = localSize(room)
  const floorGeometry = useMemo(() => scaleFloorUvs(new THREE.BoxGeometry(local.width, FLOOR_THICKNESS, local.depth), local.width, local.depth, finish), [local.width, local.depth, finish])
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry])
  const style = partitionStyle(room.department)
  const parts = useMemo(() => mergedRoomParts({ ...room, ...local }, style), [local.width, local.depth, room.wallHeight, room.department, style])
  useEffect(() => () => parts.forEach((part) => part.geometry.dispose()), [parts])
  const highlight = highlightFor({ editing, selected, hovered, invalid })
  const pointer = editing ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect() },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(true) },
    onPointerOut: () => setHovered(false),
  } : {}
  const m = sharedMaterials()
  const floorY = FLOOR_TOP - FLOOR_THICKNESS / 2
  return <group position={[room.x, 0, room.z]}>
    {floorPlan
      ? <mesh key="plan-floor" position={[0, floorY, 0]} {...pointer} {...drag}><boxGeometry args={[room.width, FLOOR_THICKNESS, room.depth]} /><meshStandardMaterial color={room.color} roughness={0.9} transparent opacity={0.95} /></mesh>
      : <group key="shell" rotation={[0, (room.rotation * Math.PI) / 180, 0]}>
        <mesh receiveShadow geometry={floorGeometry} material={floorMaterial(finish)} position={[0, floorY, 0]} {...pointer} {...drag} />
        <mesh raycast={noRaycast} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_TOP + 0.001, local.depth / 2 - ACCENT_DEPTH / 2]} material={accentMaterial(room.color)}>
          <planeGeometry args={[local.width - 2 * WALL_THICKNESS, ACCENT_DEPTH]} />
        </mesh>
        {parts.map(({ name, geometry, castShadow }) => <mesh key={name} geometry={geometry} material={name === 'accent' ? accentMaterial(room.color) : m[name]} castShadow={castShadow} receiveShadow raycast={noRaycast} />)}
      </group>}
    {highlight
      ? <FootprintOutline width={room.width} depth={room.depth} color={highlight.color} lineWidth={highlight.width} y={0.05} />
      : floorPlan && <FootprintOutline width={room.width} depth={room.depth} color={PLAN_BOUNDARY} lineWidth={1.2} y={0.05} />}
  </group>
}
