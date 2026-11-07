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

// Counter run with a front of four doors. The top is 0.9 m, the height a coffee machine stands on.
function kitchenCounter(): Pieces {
  const seams = [-0.53, 0, 0.53].map((x) => box(0.008, 0.7, 0.004, x, 0.47, 0.271))
  const handles = [-0.45, -0.08, 0.08, 0.45].map((x) => box(0.012, 0.22, 0.016, x, 0.55, 0.278))
  return {
    cabinetWhite: [box(2.12, 0.78, 0.54, 0, 0.47, 0)],
    oakVeneer: [box(2.2, 0.04, 0.6, 0, 0.88, 0)],
    plastic: [box(2.08, 0.08, 0.5, 0, 0.04, -0.01), ...seams, ...handles],
  }
}

// A small espresso machine, standing on a counter top at y = 0.9. Its group head and spouts face +Z.
function coffeeMachine(): Pieces {
  const top = 0.9
  return {
    plastic: [
      box(0.34, 0.03, 0.3, 0, top + 0.015, 0), // base
      box(0.34, 0.32, 0.22, 0, top + 0.19, -0.04), // body
    ],
    chrome: [
      box(0.26, 0.01, 0.1, 0, top + 0.035, 0.1), // drip tray
      box(0.3, 0.05, 0.08, 0, top + 0.28, 0.11), // group head
      cylinder(0.012, 0.012, 0.04, -0.05, top + 0.235, 0.12, 8),
      cylinder(0.012, 0.012, 0.04, 0.05, top + 0.235, 0.12, 8),
      box(0.3, 0.012, 0.2, 0, top + 0.356, -0.04), // top plate
      box(0.1, 0.012, 0.004, 0, top + 0.17, 0.0725), // button strip
    ],
  }
}

function diningTable(): Pieces {
  const legs = [-0.9, 0.9].flatMap((x) => [-0.37, 0.37].map((z) => box(0.06, 0.7, 0.06, x, 0.35, z)))
  const rails = [-0.37, 0.37].map((z) => box(1.74, 0.05, 0.03, 0, 0.675, z))
  const ends = [-0.9, 0.9].map((x) => box(0.03, 0.05, 0.68, x, 0.675, 0))
  return { oakVeneer: [box(2, 0.04, 0.9, 0, 0.72, 0)], graphite: [...legs, ...rails, ...ends] }
}

// Backrest at +Z. The seat is low enough to tuck under a dining table.
function diningChair(): Pieces {
  const front = [-0.2, 0.2].map((x) => box(0.03, 0.43, 0.03, x, 0.215, -0.19))
  const rear = [-0.2, 0.2].map((x) => box(0.03, 0.86, 0.03, x, 0.43, 0.2))
  return {
    fabric: [box(0.44, 0.05, 0.42, 0, 0.455, 0), box(0.37, 0.3, 0.035, 0, 0.7, 0.2)],
    graphite: [...front, ...rear, box(0.37, 0.03, 0.03, 0, 0.405, -0.19), box(0.37, 0.03, 0.03, 0, 0.405, 0.2)],
  }
}

// A plain flat rectangle with a thin raised edge, in one colour. No symbols, text or pattern.
// Its top (0.04 m) sits above the room floor surface (0.025 m) and above open floor (0 m).
function prayerMat(): Pieces {
  const edge = 0.025
  return {
    prayerMat: [
      box(0.6, 0.04, 1, 0, 0.02, 0),
      box(0.6, 0.01, edge, 0, 0.045, -0.5 + edge / 2),
      box(0.6, 0.01, edge, 0, 0.045, 0.5 - edge / 2),
      box(edge, 0.01, 1 - 2 * edge, -0.3 + edge / 2, 0.045, 0),
      box(edge, 0.01, 1 - 2 * edge, 0.3 - edge / 2, 0.045, 0),
    ],
  }
}

/** FNV-1a over the text, as an unsigned 32-bit integer. The same text always gives the same number. */
export function stableHash(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

export type PlantVariant = 0 | 1

/** Stable per-id plant size (0 = bushy, 1 = tall), so the office gets variety without storing anything new. */
export function plantVariant(id: string): PlantVariant {
  return (stableHash(id) % 2) as PlantVariant
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** A single leaf: a flattened, elongated ellipsoid tilted up by `elevation`, pointing outward at `heading`. */
function leaf(length: number, elevation: number, heading: number, y: number, offset: number) {
  return new THREE.SphereGeometry(1, 8, 6)
    .scale(0.035, 0.012, length / 2)
    .translate(0, 0, length / 2)
    .rotateX(-elevation)
    .translate(0, y, offset)
    .rotateY(heading)
}

// Matte charcoal planter with soil and a leafy crown; leaves alternate between two greens for depth.
function plant(variant: number): Pieces {
  const tall = variant === 1
  const potHeight = tall ? 0.42 : 0.36
  const tiers = tall ? [[0.78, 0.5], [0.95, 0.75], [1.12, 0.95], [1.27, 1.15]] : [[0.5, 0.35], [0.64, 0.6], [0.78, 0.85]]
  const perTier = tall ? 5 : 6
  const length = tall ? 0.24 : 0.22
  const offset = tall ? 0.04 : 0.06
  const dark: THREE.BufferGeometry[] = []
  const light: THREE.BufferGeometry[] = []
  tiers.forEach(([y, elevation], t) => {
    for (let i = 0; i < perTier; i++) {
      const n = t * perTier + i
      ;(n % 2 ? light : dark).push(leaf(length, elevation, n * GOLDEN_ANGLE, y, offset))
    }
  })
  const soil = [cylinder(0.18, 0.18, 0.02, 0, potHeight - 0.03, 0, 16)]
  if (tall) soil.push(cylinder(0.015, 0.02, 0.9, 0, potHeight + 0.43, 0, 6))
  return {
    planter: [cylinder(0.2, 0.16, potHeight, 0, potHeight / 2, 0, 20)],
    terracotta: soil,
    foliage: dark,
    foliageLight: light,
  }
}

const BUILDERS: Record<FurnitureType, (variant: number) => Pieces> = {
  desk,
  chair,
  monitor,
  plant,
  'meeting-table': meetingTable,
  'meeting-chair': meetingChair,
  'storage-cabinet': storageCabinet,
  shelf,
  'kitchen-counter': kitchenCounter,
  'coffee-machine': coffeeMachine,
  'dining-table': diningTable,
  'dining-chair': diningChair,
  'prayer-mat': prayerMat,
}

// Small details (monitors, keyboards, handles, books, chrome) skip shadow casting to keep the shadow pass cheap, as do
// dining chairs, whose count would otherwise add 32 draw calls for shadows mostly hidden under a table.
const NO_SHADOW = new Set<MaterialKey>(['plastic', 'screen', 'chrome'])
const SHADOWLESS_TYPES = new Set<FurnitureType>(['monitor', 'prayer-mat', 'dining-chair', 'coffee-machine'])

const cache = new Map<string, ModelPart[]>()

/**
 * One merged geometry per material for each furniture type, built once and shared by every instance.
 * `variant` only applies to plants (see plantVariant); other types ignore it.
 */
export function modelParts(type: FurnitureType, variant = 0): ModelPart[] {
  const v = type === 'plant' ? variant : 0
  const key = `${type}:${v}`
  let parts = cache.get(key)
  if (!parts) {
    parts = Object.entries(BUILDERS[type](v)).map(([material, geometries]) => {
      const merged = mergeGeometries(geometries.map((g) => g.toNonIndexed()), false)
      if (!merged) throw new Error(`Could not merge ${type} ${material} geometry`)
      geometries.forEach((g) => g.dispose())
      const key = material as MaterialKey
      const castShadow = !SHADOWLESS_TYPES.has(type) && (!NO_SHADOW.has(key) || type === 'chair')
      return { material: key, geometry: merged, castShadow }
    })
    cache.set(key, parts)
  }
  return parts
}
