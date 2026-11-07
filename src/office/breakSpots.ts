import { FURNITURE_SPECS } from '../layout/catalog'
import { roomAt, rotateOffset } from '../layout/geometry'
import type { OfficeLayout } from '../layout/types'
import { headingOf, type Point } from './walkMap'

export type BreakSpot = Point & { rotation: number; pose: 'sit' | 'stand' }

/** The rig's rotation for facing the qibla: a bearing of about 295 degrees from north, where -Z is north and +X is east. */
export const QIBLA_ROTATION = 65

const COUNTER_DISTANCE = 0.55
const COUNTER_SPACING = 0.7
const round = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Where agents go for each kind of break, in the order the layout lists the furniture: standing places along each
 * kitchen counter, a seat at each dining chair and a mat in each prayer room. Furniture outside a room of the right kind
 * is ignored. The same layout always gives the same lists.
 */
export function breakSpots(layout: OfficeLayout): { coffee: BreakSpot[]; dining: BreakSpot[]; prayer: BreakSpot[] } {
  const department = (x: number, z: number) => {
    const id = roomAt(layout, x, z)
    return layout.rooms.find((r) => r.id === id)?.department ?? null
  }
  const coffee: BreakSpot[] = []
  const dining: BreakSpot[] = []
  const prayer: BreakSpot[] = []
  for (const f of layout.furniture) {
    if (![f.x, f.z].every(Number.isFinite)) continue
    if (f.type === 'kitchen-counter' && department(f.x, f.z) === 'kitchen') {
      const length = FURNITURE_SPECS['kitchen-counter'].width
      const places = Math.max(1, Math.floor(length / COUNTER_SPACING + 1e-9))
      const front = rotateOffset(0, 1, f.rotation)
      const rotation = headingOf(-front.dx, -front.dz)
      for (let i = 0; i < places; i++) {
        const offset = rotateOffset((i - (places - 1) / 2) * COUNTER_SPACING, COUNTER_DISTANCE, f.rotation)
        coffee.push({ x: round(f.x + offset.dx), z: round(f.z + offset.dz), rotation, pose: 'stand' })
      }
    } else if (f.type === 'dining-chair' && department(f.x, f.z) === 'dining') {
      dining.push({ x: f.x, z: f.z, rotation: f.rotation, pose: 'sit' })
    } else if (f.type === 'prayer-mat' && department(f.x, f.z) === 'prayer') {
      prayer.push({ x: f.x, z: f.z, rotation: QIBLA_ROTATION, pose: 'stand' })
    }
  }
  return { coffee, dining, prayer }
}
