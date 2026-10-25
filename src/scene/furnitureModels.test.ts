import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FURNITURE_SPECS } from '../layout/catalog'
import type { FurnitureType } from '../layout/types'
import { modelParts } from './furnitureModels'

const TYPES = Object.keys(FURNITURE_SPECS) as FurnitureType[]

function bounds(type: FurnitureType) {
  const box = new THREE.Box3()
  for (const part of modelParts(type)) {
    part.geometry.computeBoundingBox()
    box.union(part.geometry.boundingBox!)
  }
  return box
}

describe('modelParts', () => {
  for (const type of TYPES) {
    describe(type, () => {
      it('uses at most one merged mesh per material, and at most four', () => {
        const parts = modelParts(type)
        expect(parts.length).toBeGreaterThan(0)
        expect(parts.length).toBeLessThanOrEqual(4)
        expect(new Set(parts.map((p) => p.material)).size).toBe(parts.length)
      })

      it('is built once and shared', () => {
        expect(modelParts(type)).toBe(modelParts(type))
      })

      it('stands on the floor inside its footprint and fills most of it', () => {
        const { width, depth } = FURNITURE_SPECS[type]
        const b = bounds(type)
        expect(b.min.y).toBeGreaterThanOrEqual(-1e-6)
        expect(Math.max(-b.min.x, b.max.x)).toBeLessThanOrEqual(width / 2 + 0.01)
        expect(Math.max(-b.min.z, b.max.z)).toBeLessThanOrEqual(depth / 2 + 0.01)
        expect(b.max.x - b.min.x).toBeGreaterThanOrEqual(width * 0.75)
        expect(b.max.z - b.min.z).toBeGreaterThanOrEqual(depth * 0.75)
      })
    })
  }

  const heights: [FurnitureType, 'min' | 'max', number, number][] = [
    ['desk', 'max', 0.74, 0.79],
    ['chair', 'max', 1.0, 1.12],
    ['monitor', 'min', 0.749, 0.751],
    ['monitor', 'max', 1.2, 1.3],
    ['meeting-table', 'max', 0.73, 0.77],
    ['storage-cabinet', 'max', 1.08, 1.14],
    ['shelf', 'max', 1.78, 1.84],
  ]
  for (const [type, end, lo, hi] of heights) {
    it(`gives the ${type} a realistic ${end === 'max' ? 'height' : 'base height'}`, () => {
      const y = bounds(type)[end].y
      expect(y).toBeGreaterThanOrEqual(lo)
      expect(y).toBeLessThanOrEqual(hi)
    })
  }

  it('only casts shadows from larger furniture, not monitors', () => {
    expect(modelParts('monitor').every((p) => !p.castShadow)).toBe(true)
    expect(modelParts('desk').some((p) => p.castShadow)).toBe(true)
  })
})
