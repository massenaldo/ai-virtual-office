import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { FOCUS_DISTANCE, LABEL_CLEARANCE, OVERVIEW_DIRECTION, OVERVIEW_FOV, fitOverview, focusPose, overviewPoints } from './camera'

const layout = createDefaultLayout()

/** Screen-space bounds (NDC) of the overview's framing points. */
function bounds(aspect: number, target: [number, number, number], distance: number) {
  const camera = new THREE.PerspectiveCamera(OVERVIEW_FOV, aspect, 0.1, 1000)
  const t = new THREE.Vector3(...target)
  camera.position.copy(t).addScaledVector(OVERVIEW_DIRECTION, distance)
  camera.lookAt(t)
  camera.updateMatrixWorld()
  const projected = overviewPoints(layout).map((p) => p.clone().project(camera))
  const xs = projected.map((p) => p.x)
  const ys = projected.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

const extent = (b: ReturnType<typeof bounds>) => Math.max(-b.minX, b.maxX, -b.minY, b.maxY)

describe('overviewPoints', () => {
  it('frames the floor corners and the top of every room including its label', () => {
    const points = overviewPoints(layout)
    expect(points).toHaveLength(4 + layout.rooms.length * 4)
    const ceo = layout.rooms[0]
    expect(points.some((p) => p.x === ceo.x - ceo.width / 2 && p.z === ceo.z - ceo.depth / 2 && p.y === ceo.wallHeight + LABEL_CLEARANCE)).toBe(true)
    expect(points.some((p) => p.x === -layout.office.width / 2 && p.y === 0 && p.z === -layout.office.depth / 2)).toBe(true)
  })
})

describe('fitOverview', () => {
  for (const aspect of [2.7, 1.4, 0.8]) {
    it(`fits the floor, walls and labels inside the frame at aspect ${aspect}`, () => {
      const { target, distance } = fitOverview(layout, aspect)
      expect(Number.isFinite(distance)).toBe(true)
      expect(extent(bounds(aspect, target, distance))).toBeLessThanOrEqual(0.95 + 1e-6)
    })

    it(`centres the office on screen at aspect ${aspect}`, () => {
      const { target, distance } = fitOverview(layout, aspect)
      const b = bounds(aspect, target, distance)
      expect(Math.abs((b.minX + b.maxX) / 2)).toBeLessThan(0.03)
      expect(Math.abs((b.minY + b.maxY) / 2)).toBeLessThan(0.03)
    })

    it(`is a tight fit at aspect ${aspect}`, () => {
      const { target, distance } = fitOverview(layout, aspect)
      expect(extent(bounds(aspect, target, distance * 0.97))).toBeGreaterThan(0.95)
    })
  }

  it('keeps the target at floor level and the existing view angle', () => {
    expect(fitOverview(layout, 2.7).target[1]).toBeCloseTo(0.4, 9)
    expect(OVERVIEW_DIRECTION.toArray().map((v) => +v.toFixed(4))).toEqual(new THREE.Vector3(15, 17, 19).normalize().toArray().map((v) => +v.toFixed(4)))
  })
})

describe('focusPose', () => {
  it('aims at a point in 3D and plan', () => {
    const pose = focusPose({ x: 1, z: 2 }, false)
    expect(pose.target).toEqual([1, 0.4, 2])
    const offset = new THREE.Vector3(...pose.position).sub(new THREE.Vector3(...pose.target))
    expect(FOCUS_DISTANCE).toBe(9)
    expect(offset.length()).toBeCloseTo(9)
    expect(offset.normalize().dot(OVERVIEW_DIRECTION)).toBeCloseTo(1)
    expect(focusPose({ x: 1, z: 2 }, true)).toEqual({ target: [1, 0, 2], position: [1, 40, 2.001] })
  })
})
