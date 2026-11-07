import { CHAIR_OFFSET_Z } from './defaultLayout'
import type { Furniture, OfficeLayout, Rotation } from './types'

/** Where a character sits: world x and z, the facing in degrees (the desk's), and whether a chair is there. */
export type Seat = { x: number; z: number; rotation: number; seated: boolean }

const MAX_CHAIR_DISTANCE = 0.9
const round = (n: number) => Math.round(n * 100) / 100

// Exact unit vectors for quarter turns, so no -0 or 1e-17 leaks out of sin and cos.
const FORWARD: Record<Rotation, [sin: number, cos: number]> = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] }

/**
 * The seat for a desk: the nearest chair within 0.9 m of the point CHAIR_OFFSET_Z in front of the desk (turned with the desk),
 * or that point itself, standing, when no chair is near. The character always faces the way the desk faces.
 */
export function seatForDesk(layout: OfficeLayout, desk: Furniture): Seat {
  const [sin, cos] = FORWARD[desk.rotation]
  const px = round(desk.x + CHAIR_OFFSET_Z * sin)
  const pz = round(desk.z + CHAIR_OFFSET_Z * cos)
  let best: Furniture | null = null
  let bestDistance = MAX_CHAIR_DISTANCE
  for (const f of layout.furniture) {
    if (f.type !== 'chair') continue
    const d = Math.hypot(f.x - px, f.z - pz)
    if (d <= bestDistance) {
      best = f
      bestDistance = d
    }
  }
  return best ? { x: best.x, z: best.z, rotation: desk.rotation, seated: true } : { x: px, z: pz, rotation: desk.rotation, seated: false }
}
