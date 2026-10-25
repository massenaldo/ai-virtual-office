import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { OVERVIEW_DIRECTION, OVERVIEW_FOV, OVERVIEW_TARGET, fitOverviewDistance } from './camera'

const office = createDefaultLayout().office

/** Largest |NDC| coordinate of the office's corners (floor and wall-top level) seen from the overview at this distance. */
function maxNdc(aspect: number, distance: number) {
  const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV, aspect, 0.1, 1000)
  const target = new THREE.Vector3(...OVERVIEW_TARGET)
  camera.position.copy(target).addScaledVector(OVERVIEW_DIRECTION, distance)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  let max = 0
  for (const x of [-1, 1]) for (const y of [0, 2.5]) for (const z of [-1, 1]) {
    const p = new THREE.Vector3((x * office.width) / 2, y, (z * office.depth) / 2).project(camera)
    max = Math.max(max, Math.abs(p.x), Math.abs(p.y))
  }
  return max
}

describe('fitOverviewDistance', () => {
  for (const aspect of [2.5, 1.4, 0.8]) {
    it(`fits the whole office inside the frame at aspect ${aspect}`, () => {
      const d = fitOverviewDistance(office, aspect)
      expect(Number.isFinite(d)).toBe(true)
      expect(maxNdc(aspect, d)).toBeLessThanOrEqual(0.9 + 1e-6)
    })

    it(`is a tight fit at aspect ${aspect}`, () => {
      expect(maxNdc(aspect, fitOverviewDistance(office, aspect) * 0.95)).toBeGreaterThan(0.9)
    })
  }

  it('keeps the existing view angle', () => {
    expect(OVERVIEW_DIRECTION.toArray().map((v) => +v.toFixed(4))).toEqual(new THREE.Vector3(15, 17, 19).normalize().toArray().map((v) => +v.toFixed(4)))
  })
})
