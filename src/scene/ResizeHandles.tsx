import { useEffect, useState } from 'react'
import type { Edge } from '../layout/operations'
import type { Room, Selection } from '../layout/types'
import type { TransformIntent } from '../editor/transform'
import { HIGHLIGHT } from './highlight'
import { useFloorDrag } from './useFloorDrag'

type HandleProps = { room: Room; edge: Edge; onTransformStart(target: NonNullable<Selection>): void; onTransform(intent: TransformIntent): void; onTransformEnd(): void }

const HANDLE_SIZE = 0.32

function edgePoint(room: Room, edge: Edge) {
  if (edge === 'e') return { x: room.x + room.width / 2, z: room.z }
  if (edge === 'w') return { x: room.x - room.width / 2, z: room.z }
  if (edge === 's') return { x: room.x, z: room.z + room.depth / 2 }
  return { x: room.x, z: room.z - room.depth / 2 }
}

function Handle({ room, edge, onTransformStart, onTransform, onTransformEnd }: HandleProps) {
  const [hovered, setHovered] = useState(false)
  const horizontal = edge === 'e' || edge === 'w'
  const at = edgePoint(room, edge)
  const drag = useFloorDrag({
    enabled: true,
    origin: () => edgePoint(room, edge),
    onStart: () => onTransformStart({ kind: 'room', id: room.id }),
    onMove: (p) => onTransform({ kind: 'resize', roomId: room.id, edge, coordinate: horizontal ? p.x : p.z }),
    onEnd: onTransformEnd,
  })
  const setCursor = (cursor: string) => { document.body.style.cursor = cursor }
  // A handle can unmount while hovered (selection cleared), which never fires pointer-out.
  useEffect(() => () => setCursor(''), [])
  return <mesh position={[at.x, 0.12, at.z]} renderOrder={6} {...drag}
    onPointerOver={(e) => { e.stopPropagation(); setHovered(true); setCursor(horizontal ? 'ew-resize' : 'ns-resize') }}
    onPointerOut={() => { setHovered(false); setCursor('') }}>
    <boxGeometry args={[HANDLE_SIZE, 0.08, HANDLE_SIZE]} />
    <meshBasicMaterial color={hovered ? '#ffffff' : HIGHLIGHT.selected} depthTest={false} />
  </mesh>
}

/** Edge-midpoint handles on the selected room; dragging one moves that edge while the opposite edge stays put. */
export default function ResizeHandles(props: Omit<HandleProps, 'edge'>) {
  return <>{(['n', 's', 'e', 'w'] as const).map((edge) => <Handle key={edge} edge={edge} {...props} />)}</>
}
