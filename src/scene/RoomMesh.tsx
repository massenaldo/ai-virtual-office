import { useEffect, useMemo, useState } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import type { Room, Selection } from '../layout/types'
import type { TransformIntent } from '../editor/transform'
import { roomBaseboards, roomDetails, roomWalls, WALL_THICKNESS, type Box, type DetailKind } from './architecture'
import { floorFinishFor, partitionStyle } from './finishes'
import FootprintOutline from './FootprintOutline'
import { highlightFor } from './highlight'
import { accentMaterial, floorMaterial, sharedMaterials } from './materials'
import { scaleFloorUvs } from './textures'
import { useFloorDrag } from './useFloorDrag'

// Walls, glass and trim never take clicks, so objects inside a room stay selectable from any angle.
const noRaycast = () => null

const FLOOR_THICKNESS = 0.02
const FLOOR_TOP = 0.025
const ACCENT_DEPTH = 0.06
const PLAN_BOUNDARY = '#56616b'

// One unit box scaled per mesh, so every wall, pane and baseboard shares a single geometry.
const unitBox = new THREE.BoxGeometry(1, 1, 1)
let wallFaces: THREE.Material[] | null = null
// Box face order is +X, −X, +Y, −Y, +Z, −Z: the top (+Y) gets the dark cut colour of a cutaway drawing.
const wallMaterials = () => {
  const m = sharedMaterials()
  wallFaces ??= [m.wallPaint, m.wallPaint, m.wallCap, m.wallPaint, m.wallPaint, m.wallPaint]
  return wallFaces
}

function detailMaterial(kind: DetailKind, color: string): THREE.Material {
  const m = sharedMaterials()
  if (kind === 'art-canvas') return accentMaterial(color)
  if (kind === 'whiteboard') return m.whiteboard
  return m.graphite
}

function Part({ box, material, castShadow = false }: { box: Box; material: THREE.Material | THREE.Material[]; castShadow?: boolean }) {
  return <mesh geometry={unitBox} material={material} position={[box.x, box.y, box.z]} scale={[box.w, box.h, box.d]} castShadow={castShadow} receiveShadow raycast={noRaycast} />
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
  const floorGeometry = useMemo(() => scaleFloorUvs(new THREE.BoxGeometry(room.width, FLOOR_THICKNESS, room.depth), room.width, room.depth, finish), [room.width, room.depth, finish])
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry])
  const style = partitionStyle(room.department)
  const walls = useMemo(() => roomWalls(room, style), [room.width, room.depth, room.wallHeight, style])
  const baseboards = useMemo(() => roomBaseboards(room, style), [room.width, room.depth, room.wallHeight, style])
  const details = useMemo(() => roomDetails(room, style), [room.width, room.depth, room.wallHeight, room.department, style])
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
      : <mesh key="floor" receiveShadow geometry={floorGeometry} material={floorMaterial(finish)} position={[0, floorY, 0]} {...pointer} {...drag} />}
    {!floorPlan && <>
      <mesh raycast={noRaycast} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_TOP + 0.001, room.depth / 2 - ACCENT_DEPTH / 2]} material={accentMaterial(room.color)}>
        <planeGeometry args={[room.width - 2 * WALL_THICKNESS, ACCENT_DEPTH]} />
      </mesh>
      {walls.solid.map((box, i) => <Part key={`wall-${i}`} box={box} material={wallMaterials()} castShadow />)}
      {walls.glass.map((box, i) => <Part key={`glass-${i}`} box={box} material={m.glass} />)}
      {walls.frames.map((box, i) => <Part key={`frame-${i}`} box={box} material={m.graphite} />)}
      {baseboards.map((box, i) => <Part key={`base-${i}`} box={box} material={m.baseboard} />)}
      {details.map(({ kind, box }, i) => <Part key={`detail-${i}`} box={box} material={detailMaterial(kind, room.color)} />)}
    </>}
    {highlight
      ? <FootprintOutline width={room.width} depth={room.depth} color={highlight.color} lineWidth={highlight.width} y={0.05} />
      : floorPlan && <FootprintOutline width={room.width} depth={room.depth} color={PLAN_BOUNDARY} lineWidth={1.2} y={0.05} />}
  </group>
}
