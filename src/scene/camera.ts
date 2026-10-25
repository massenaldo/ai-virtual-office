import * as THREE from 'three'
import type { OfficeLayout } from '../layout/types'

export const OVERVIEW_TARGET: [number, number, number] = [0, 0.4, 0]
/** The original prototype's viewing angle, kept so the overview still feels familiar. */
export const OVERVIEW_DIRECTION = new THREE.Vector3(15, 17, 19).normalize()
export const OVERVIEW_FOV = 42
/** Height above a room's walls kept in frame for its floating label. */
export const LABEL_CLEARANCE = 0.6

const camera = new THREE.PerspectiveCamera()
const target = new THREE.Vector3()
const projected = new THREE.Vector3()
const ray = new THREE.Raycaster()
const targetPlane = new THREE.Plane()
const centre = new THREE.Vector3()

type Bounds = { minX: number; maxX: number; minY: number; maxY: number }

type Framing = Pick<OfficeLayout, 'office' | 'rooms'>

/** What the overview must show: the office floor's corners and each room's wall-top corners plus label clearance. */
export function overviewPoints({ office, rooms }: Framing): THREE.Vector3[] {
  const points = [-1, 1].flatMap((x) => [-1, 1].map((z) => new THREE.Vector3((x * office.width) / 2, 0, (z * office.depth) / 2)))
  for (const r of rooms) {
    for (const x of [-1, 1]) for (const z of [-1, 1]) points.push(new THREE.Vector3(r.x + (x * r.width) / 2, r.wallHeight + LABEL_CLEARANCE, r.z + (z * r.depth) / 2))
  }
  return points
}

/** Screen-space (NDC) bounds of the framing points with the camera at `distance` from the current target. */
function pointBounds(points: THREE.Vector3[], distance: number): Bounds {
  camera.position.copy(target).addScaledVector(OVERVIEW_DIRECTION, distance)
  camera.lookAt(target)
  camera.updateMatrixWorld()
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  for (const p of points) {
    projected.copy(p).project(camera)
    b.minX = Math.min(b.minX, projected.x); b.maxX = Math.max(b.maxX, projected.x)
    b.minY = Math.min(b.minY, projected.y); b.maxY = Math.max(b.maxY, projected.y)
  }
  return b
}

const fits = (b: Bounds, margin: number) => Math.max(-b.minX, b.maxX, -b.minY, b.maxY) <= margin

function fitDistance(points: THREE.Vector3[], margin: number): number {
  let near = 5
  let far = 120
  for (let i = 0; i < 30; i++) {
    const mid = (near + far) / 2
    if (fits(pointBounds(points, mid), margin)) far = mid
    else near = mid
  }
  return far
}

/**
 * Overview framing for the whole office: the camera keeps the original viewing angle, aims at the office's
 * on-screen centre (so perspective doesn't leave the far half of the frame empty) and moves as close as the
 * `margin` allows while the floor, every room's walls and their labels stay in frame.
 */
export function fitOverview(layout: Framing, aspect: number, fovDeg = OVERVIEW_FOV, margin = 0.95): { target: [number, number, number]; distance: number } {
  camera.fov = fovDeg
  camera.aspect = aspect
  camera.near = 0.1
  camera.far = 1000
  camera.updateProjectionMatrix()
  target.set(...OVERVIEW_TARGET)
  targetPlane.set(new THREE.Vector3(0, 1, 0), -OVERVIEW_TARGET[1])
  const points = overviewPoints(layout)
  let distance = fitDistance(points, margin)
  // Re-aim at the floor's on-screen centre and refit until the framing settles.
  for (let i = 0; i < 8; i++) {
    const b = pointBounds(points, distance)
    ray.setFromCamera(new THREE.Vector2((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2), camera)
    if (!ray.ray.intersectPlane(targetPlane, centre)) break
    target.copy(centre)
    distance = fitDistance(points, margin)
  }
  return { target: [target.x, target.y, target.z], distance }
}
