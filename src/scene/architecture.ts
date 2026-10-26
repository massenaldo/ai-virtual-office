import type { Room } from '../layout/types'
import type { PartitionStyle, Side } from './finishes'

export const WALL_THICKNESS = 0.12
export const GLASS_THICKNESS = 0.04
export const BASEBOARD = { height: 0.08, depth: 0.015 }

/** Axis-aligned box as centre + size, in room-local coordinates (origin at the room's footprint centre, y up from the floor). */
export type Box = { x: number; y: number; z: number; w: number; h: number; d: number }

type RoomShape = Pick<Room, 'width' | 'depth' | 'wallHeight'>

export const FRAME = { width: 0.05, depth: 0.06, maxSpan: 1.5 }

const ALL_SOLID: PartitionStyle = { left: 'solid', right: 'solid' }
const thickness = (side: Side) => (side === 'solid' ? WALL_THICKNESS : GLASS_THICKNESS)

/**
 * Slim graphite frame for a glass pane running along X (`axis: 'x'`) or Z, whose outer face sits on the footprint edge:
 * top and bottom rails plus mullions at both ends and evenly between, never more than FRAME.maxSpan apart.
 */
function paneFrame(axis: 'x' | 'z', start: number, end: number, edge: number, inward: 1 | -1, height: number): Box[] {
  const length = end - start
  const across = edge + (inward * FRAME.depth) / 2
  const along = (centre: number, size: number, y: number, h: number): Box =>
    axis === 'x' ? { x: centre, y, z: across, w: size, h, d: FRAME.depth } : { x: across, y, z: centre, w: FRAME.depth, h, d: size }
  const rails = [along((start + end) / 2, length, FRAME.width / 2, FRAME.width), along((start + end) / 2, length, height - FRAME.width / 2, FRAME.width)]
  const segments = Math.max(1, Math.ceil(length / FRAME.maxSpan))
  const first = start + FRAME.width / 2
  const step = (length - FRAME.width) / segments
  const mullions = Array.from({ length: segments + 1 }, (_, i) => along(first + i * step, FRAME.width, height / 2, height))
  return [...rails, ...mullions]
}

/**
 * Cutaway room shell: side walls (−X, +X) whose outer faces sit on the footprint edge, solid or glass per `style`,
 * a glass back (−Z) spanning between them, and an open front (+Z). Glass gets slim frames. Everything stays inside
 * the footprint so walls match selection outlines.
 */
export function roomWalls({ width, depth, wallHeight }: RoomShape, style: PartitionStyle = ALL_SOLID): { solid: Box[]; glass: Box[]; frames: Box[] } {
  const solid: Box[] = []
  const glass: Box[] = []
  const frames: Box[] = []
  for (const [side, sign] of [[style.left, -1], [style.right, 1]] as const) {
    const t = thickness(side)
    const wall = { x: sign * (width / 2 - t / 2), y: wallHeight / 2, z: 0, w: t, h: wallHeight, d: depth }
    if (side === 'solid') solid.push(wall)
    else {
      glass.push(wall)
      frames.push(...paneFrame('z', -depth / 2, depth / 2, sign * (width / 2), sign === 1 ? -1 : 1, wallHeight))
    }
  }
  const leftInner = -width / 2 + thickness(style.left)
  const rightInner = width / 2 - thickness(style.right)
  glass.push({ x: (leftInner + rightInner) / 2, y: wallHeight / 2, z: -depth / 2 + GLASS_THICKNESS / 2, w: rightInner - leftInner, h: wallHeight, d: GLASS_THICKNESS })
  frames.push(...paneFrame('x', leftInner, rightInner, -depth / 2, 1, wallHeight))
  return { solid, glass, frames }
}

/** Baseboards along the inner face of each solid side wall, from the glass to the open front. */
export function roomBaseboards({ width, depth }: RoomShape, style: PartitionStyle = ALL_SOLID): Box[] {
  const length = depth - GLASS_THICKNESS
  const x = width / 2 - WALL_THICKNESS - BASEBOARD.depth / 2
  const z = GLASS_THICKNESS / 2
  return ([[style.left, -1], [style.right, 1]] as const)
    .filter(([side]) => side === 'solid')
    .map(([, sign]) => ({ x: sign * x, y: BASEBOARD.height / 2, z, w: BASEBOARD.depth, h: BASEBOARD.height, d: length }))
}
