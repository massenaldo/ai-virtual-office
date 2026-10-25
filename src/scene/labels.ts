import * as THREE from 'three'
import type { Room } from '../layout/types'

const LABEL_LIFT = 0.22
const PLAN_LABEL_HEIGHT = 0.3

/** Where a room's label floats: just above its walls in 3D, just above the floor in floor plan. */
export function labelAnchor(room: Pick<Room, 'x' | 'z' | 'wallHeight'>, floorPlan: boolean, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(room.x, floorPlan ? PLAN_LABEL_HEIGHT : room.wallHeight + LABEL_LIFT, room.z)
}

const projected = new THREE.Vector3()
const round = (n: number) => Math.round(n * 100) / 100

/** Pixel position of a world point on the canvas; points behind the camera or past the far plane are not visible. */
export function screenPosition(point: THREE.Vector3, camera: THREE.Camera, size: { width: number; height: number }): { x: number; y: number; visible: boolean } {
  projected.copy(point).project(camera)
  return {
    x: round(((projected.x + 1) / 2) * size.width),
    y: round(((1 - projected.y) / 2) * size.height),
    visible: projected.z > -1 && projected.z < 1,
  }
}
