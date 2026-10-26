import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Box } from './architecture'

/** Which faces of each box to keep: all six, only the top (+Y), or every face but the top. */
export type FaceSet = 'all' | 'top' | 'sides'

// BoxGeometry builds one index group per face in the order +X, −X, +Y, −Y, +Z, −Z.
const TOP_GROUP = 2

function boxGeometry({ x, y, z, w, h, d }: Box, faces: FaceSet): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d).translate(x, y, z)
  if (faces !== 'all') {
    const index = geometry.index!.array
    const kept = geometry.groups
      .filter((_, i) => (faces === 'top') === (i === TOP_GROUP))
      .flatMap((group) => Array.from(index.slice(group.start, group.start + group.count)))
    geometry.setIndex(kept)
  }
  geometry.clearGroups()
  return geometry
}

/**
 * Merges room parts into one geometry so a room draws each material once instead of once per wall, pane or trim.
 * Returns null for an empty list, so callers can skip the mesh.
 */
export function mergeBoxes(boxes: Box[], faces: FaceSet = 'all'): THREE.BufferGeometry | null {
  if (boxes.length === 0) return null
  const parts = boxes.map((box) => boxGeometry(box, faces))
  const merged = mergeGeometries(parts, false)
  parts.forEach((g) => g.dispose())
  if (!merged) throw new Error('Could not merge room geometry')
  return merged
}
