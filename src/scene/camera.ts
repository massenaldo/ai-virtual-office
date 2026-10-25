import * as THREE from 'three'
import type { OfficeSettings } from '../layout/types'

export const OVERVIEW_TARGET: [number, number, number] = [0, 0.4, 0]
/** The original prototype's viewing angle, kept so the overview still feels familiar. */
export const OVERVIEW_DIRECTION = new THREE.Vector3(15, 17, 19).normalize()
export const OVERVIEW_FOV = 42

const CORNER_HEIGHT = 2.5
const camera = new THREE.PerspectiveCamera()
const target = new THREE.Vector3()
const corner = new THREE.Vector3()

function fits(office: OfficeSettings, distance: number, margin: number): boolean {
  camera.position.copy(target).addScaledVector(OVERVIEW_DIRECTION, distance)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  for (const x of [-1, 1]) for (const y of [0, CORNER_HEIGHT]) for (const z of [-1, 1]) {
    corner.set((x * office.width) / 2, y, (z * office.depth) / 2).project(camera)
    if (Math.abs(corner.x) > margin || Math.abs(corner.y) > margin) return false
  }
  return true
}

/** Smallest overview distance at which the whole office (floor and wall tops) fits within `margin` of the frame. */
export function fitOverviewDistance(office: OfficeSettings, aspect: number, fovDeg = OVERVIEW_FOV, margin = 0.9): number {
  camera.fov = fovDeg
  camera.aspect = aspect
  camera.near = 0.1
  camera.far = 1000
  camera.updateProjectionMatrix()
  target.set(...OVERVIEW_TARGET)
  let near = 5
  let far = 120
  for (let i = 0; i < 30; i++) {
    const mid = (near + far) / 2
    if (fits(office, mid, margin)) far = mid
    else near = mid
  }
  return far
}
