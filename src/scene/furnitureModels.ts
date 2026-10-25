import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { FurnitureType } from '../layout/types'
import type { MaterialKey } from './materials'

export type ModelPart = { material: MaterialKey; geometry: THREE.BufferGeometry; castShadow: boolean }

// Models are built in metres around the footprint centre, standing on y = 0. At rotation 0 the user faces −Z:
// monitor screens and cabinet fronts face +Z, chair backrests sit at +Z.

type Pieces = Partial<Record<MaterialKey, THREE.BufferGeometry[]>>

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z)
const cylinder = (radiusTop: number, radiusBottom: number, h: number, x = 0, y = 0, z = 0, segments = 12) =>
  new THREE.CylinderGeometry(radiusTop, radiusBottom, h, segments).translate(x, y, z)
const sphere = (r: number, x = 0, y = 0, z = 0) => new THREE.SphereGeometry(r, 14, 10).translate(x, y, z)

function desk(): Pieces {
  const legs = [-0.62, 0.62].flatMap((x) => [
    box(0.06, 0.69, 0.06, x, 0.375, 0), // post
    box(0.06, 0.03, 0.68, x, 0.015, 0), // foot
    box(0.05, 0.03, 0.66, x, 0.705, 0), // rail under the top
  ])
  return {
    oakVeneer: [box(1.4, 0.03, 0.72, 0, 0.735, 0)],
    graphite: [...legs, box(1.18, 0.05, 0.04, 0, 0.68, -0.25), box(0.9, 0.06, 0.12, 0, 0.64, -0.26)],
    plastic: [box(0.44, 0.02, 0.14, 0, 0.76, 0.12), box(0.06, 0.02, 0.1, 0.3, 0.76, 0.14)],
  }
}

function chair(): Pieces {
  const spokes: THREE.BufferGeometry[] = []
  const wheels: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2
    spokes.push(box(0.04, 0.03, 0.27, 0, 0.07, 0.135).rotateY(angle))
    wheels.push(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 10).rotateZ(Math.PI / 2).translate(0, 0.025, 0.27).rotateY(angle))
  }
  const back = box(0.46, 0.55, 0.05).rotateX(-0.12).translate(0, 0.76, 0.24)
  return {
    fabric: [box(0.5, 0.07, 0.48, 0, 0.45, -0.01), back],
    plastic: [
      ...spokes, ...wheels,
      ...[-0.25, 0.25].flatMap((x) => [box(0.03, 0.2, 0.04, x, 0.58, 0.05), box(0.05, 0.025, 0.24, x, 0.69, 0.02)]),
      box(0.12, 0.3, 0.03, 0, 0.6, 0.22), // back support
    ],
    chrome: [cylinder(0.025, 0.025, 0.32, 0, 0.25), cylinder(0.05, 0.05, 0.04, 0, 0.09)],
  }
}

function monitor(): Pieces {
  return {
    plastic: [box(0.22, 0.015, 0.18, 0, 0.7575, 0), box(0.04, 0.24, 0.025, 0, 0.885, -0.05), box(0.56, 0.34, 0.025, 0, 1.09, -0.03)],
    screen: [box(0.54, 0.32, 0.004, 0, 1.09, -0.016)],
  }
}

function meetingTable(): Pieces {
  const pedestals = [-0.85, 0.85].flatMap((x) => [box(0.12, 0.68, 0.12, x, 0.36, 0), box(0.6, 0.02, 0.8, x, 0.01, 0), box(0.5, 0.02, 0.7, x, 0.69, 0)])
  return { walnut: [box(2.7, 0.04, 1.15, 0, 0.72, 0)], graphite: pedestals }
}

function meetingChair(): Pieces {
  const legs = [-0.22, 0.22].flatMap((x) => [-0.2, 0.2].map((z) => box(0.025, 0.43, 0.025, x, 0.215, z)))
  return {
    fabric: [box(0.46, 0.06, 0.44, 0, 0.46, 0), box(0.44, 0.4, 0.04, 0, 0.71, 0.21)],
    graphite: legs,
  }
}

function storageCabinet(): Pieces {
  return {
    cabinetWhite: [box(0.8, 1.02, 0.43, 0, 0.56, 0)],
    oakVeneer: [box(0.8, 0.03, 0.45, 0, 1.085, 0)],
    plastic: [box(0.78, 0.05, 0.4, 0, 0.025, 0), box(0.004, 0.9, 0.004, 0, 0.56, 0.217), box(0.015, 0.25, 0.015, -0.03, 0.75, 0.2225), box(0.015, 0.25, 0.015, 0.03, 0.75, 0.2225)],
  }
}

function shelf(): Pieces {
  const boards = [0.0125, 0.45, 0.9, 1.35, 1.7875].map((y) => box(0.84, 0.025, 0.33, 0, y, 0))
  const books = [
    [-0.36, 0.024, 0.2], [-0.32, 0.03, 0.24], [-0.28, 0.026, 0.22], [-0.24, 0.032, 0.26], [0.1, 0.03, 0.23], [0.14, 0.026, 0.2],
  ].flatMap(([x, w, h]) => [box(w, h, 0.22, x, 0.4625 + h / 2, 0), box(w, h * 0.9, 0.22, -x, 0.9125 + (h * 0.9) / 2, 0)])
  return {
    walnut: [box(0.03, 1.8, 0.35, -0.435, 0.9, 0), box(0.03, 1.8, 0.35, 0.435, 0.9, 0), box(0.84, 1.8, 0.01, 0, 0.9, -0.17), ...boards],
    plastic: books,
  }
}

// Ported from the prototype and shrunk to its footprint; Stage C replaces it with a leafy plant.
function plant(): Pieces {
  return {
    terracotta: [cylinder(0.2, 0.16, 0.42, 0, 0.21, 0, 16)],
    foliage: [sphere(0.28, 0, 0.7, 0), sphere(0.2, 0.06, 0.92, 0.03)],
  }
}

const BUILDERS: Record<FurnitureType, () => Pieces> = {
  desk,
  chair,
  monitor,
  plant,
  'meeting-table': meetingTable,
  'meeting-chair': meetingChair,
  'storage-cabinet': storageCabinet,
  shelf,
}

// Small details (monitors, keyboards, handles, books, chrome) skip shadow casting to keep the shadow pass cheap.
const NO_SHADOW = new Set<MaterialKey>(['plastic', 'screen', 'chrome'])
const SHADOWLESS_TYPES = new Set<FurnitureType>(['monitor'])

const cache = new Map<FurnitureType, ModelPart[]>()

/** One merged geometry per material for each furniture type, built once and shared by every instance. */
export function modelParts(type: FurnitureType): ModelPart[] {
  let parts = cache.get(type)
  if (!parts) {
    parts = Object.entries(BUILDERS[type]()).map(([material, geometries]) => {
      const merged = mergeGeometries(geometries.map((g) => g.toNonIndexed()), false)
      if (!merged) throw new Error(`Could not merge ${type} ${material} geometry`)
      geometries.forEach((g) => g.dispose())
      const key = material as MaterialKey
      const castShadow = !SHADOWLESS_TYPES.has(type) && (!NO_SHADOW.has(key) || type === 'chair')
      return { material: key, geometry: merged, castShadow }
    })
    cache.set(type, parts)
  }
  return parts
}
