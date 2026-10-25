import type { Room } from '../layout/types'

export const WALL_THICKNESS = 0.12
export const GLASS_THICKNESS = 0.04
export const BASEBOARD = { height: 0.08, depth: 0.015 }

/** Axis-aligned box as centre + size, in room-local coordinates (origin at the room's footprint centre, y up from the floor). */
export type Box = { x: number; y: number; z: number; w: number; h: number; d: number }

type RoomShape = Pick<Room, 'width' | 'depth' | 'wallHeight'>

/**
 * Cutaway room shell: solid side walls (−X, +X) whose outer faces sit on the footprint edge, a glass back (−Z)
 * spanning between them, and an open front (+Z). Everything stays inside the footprint so walls match selection outlines.
 */
export function roomWalls({ width, depth, wallHeight }: RoomShape): { solid: Box[]; glass: Box[] } {
  const sideX = width / 2 - WALL_THICKNESS / 2
  const solid = [-sideX, sideX].map((x) => ({ x, y: wallHeight / 2, z: 0, w: WALL_THICKNESS, h: wallHeight, d: depth }))
  const glass = [{ x: 0, y: wallHeight / 2, z: -depth / 2 + GLASS_THICKNESS / 2, w: width - 2 * WALL_THICKNESS, h: wallHeight, d: GLASS_THICKNESS }]
  return { solid, glass }
}

/** Baseboards along the inner face of each side wall, from the glass to the open front. */
export function roomBaseboards({ width, depth }: RoomShape): Box[] {
  const length = depth - GLASS_THICKNESS
  const x = width / 2 - WALL_THICKNESS - BASEBOARD.depth / 2
  const z = GLASS_THICKNESS / 2
  return [-x, x].map((bx) => ({ x: bx, y: BASEBOARD.height / 2, z, w: BASEBOARD.depth, h: BASEBOARD.height, d: length }))
}
