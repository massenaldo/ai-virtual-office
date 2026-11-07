import type * as THREE from 'three'
import { characterLook } from './characterLook'
import { CHARACTER_PARTS, partColor, type CharacterPartEntry, type CharacterStatus } from './characterRig'

/** One agent at a desk, as the scene draws it. Scene-side shape, so the scene never imports workforce types. */
export type SceneCharacter = {
  id: string
  deskId: string
  x: number
  z: number
  /** The desk's rotation in degrees; the character faces the way the desk does. */
  rotation: number
  seated: boolean
  status: CharacterStatus
  /** When the current task finished (ms since the epoch), or null. */
  doneAt: number | null
  /** The department colour. */
  accent: string
}

export type PartInstance = { characterIndex: number; entry: CharacterPartEntry; color: string }

/** Everything drawn with one geometry: one InstancedMesh, with one instance for every (character, entry) that character uses. */
export type GeometryGroup = { geometry: THREE.BufferGeometry; castShadow: boolean; instances: PartInstance[] }

/**
 * The instances of every character, grouped by unique geometry so left and right limbs share a mesh. A group exists only while
 * some character uses it, so the number of groups depends on the parts in use and never on the number of characters.
 * Entries a look does not use (`partColor` null) are left out. Visibility by action is decided per frame, see `partVisible`.
 */
export function buildPartInstances(characters: SceneCharacter[]): GeometryGroup[] {
  const groups = new Map<THREE.BufferGeometry, GeometryGroup>()
  for (const entry of CHARACTER_PARTS) {
    if (!groups.has(entry.geometry)) groups.set(entry.geometry, { geometry: entry.geometry, castShadow: false, instances: [] })
  }
  characters.forEach((c, characterIndex) => {
    const look = characterLook(c.id)
    for (const entry of CHARACTER_PARTS) {
      const color = partColor(entry.part, look, c.accent)
      if (color === null) continue
      const group = groups.get(entry.geometry)!
      group.instances.push({ characterIndex, entry, color })
      if (entry.castShadow) group.castShadow = true
    }
  })
  return [...groups.values()].filter((g) => g.instances.length > 0)
}
