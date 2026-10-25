import { useRef } from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { pastDragThreshold } from '../editor/transform'

type Point = { x: number; z: number }
type Controls = { enabled: boolean } | null

const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const hit = new THREE.Vector3()

function floorPoint(e: ThreeEvent<PointerEvent>): Point | null {
  return e.ray.intersectPlane(FLOOR, hit) ? { x: hit.x, z: hit.z } : null
}

export type FloorDragOptions = {
  enabled: boolean
  /** Current position of the dragged thing; the grab offset keeps it from jumping to the pointer. */
  origin(): Point
  onStart(): void
  onMove(point: Point): void
  onEnd(): void
}

/**
 * Pointer handlers for dragging something across the floor plane. Pressing on the object never orbits the camera,
 * a press that moves less than the threshold stays a click, and pointer capture keeps the drag alive outside the canvas.
 */
export function useFloorDrag(opts: FloorDragOptions) {
  const controls = useThree((s) => s.controls) as Controls
  const latest = useRef(opts)
  latest.current = opts
  const drag = useRef<{ pointerId: number; screen: { x: number; y: number }; offset: Point; active: boolean } | null>(null)

  const finish = () => {
    const d = drag.current
    drag.current = null
    if (controls) controls.enabled = true
    if (d?.active) latest.current.onEnd()
  }

  if (!opts.enabled) return {}
  return {
    onPointerDown(e: ThreeEvent<PointerEvent>) {
      if (e.button !== 0) return
      const point = floorPoint(e)
      if (!point) return
      e.stopPropagation()
      const origin = latest.current.origin()
      drag.current = { pointerId: e.pointerId, screen: { x: e.clientX, y: e.clientY }, offset: { x: origin.x - point.x, z: origin.z - point.z }, active: false }
      if (controls) controls.enabled = false
      ;(e.target as unknown as Element).setPointerCapture(e.pointerId)
    },
    onPointerMove(e: ThreeEvent<PointerEvent>) {
      const d = drag.current
      if (!d || d.pointerId !== e.pointerId) return
      e.stopPropagation()
      if (!d.active) {
        if (!pastDragThreshold(d.screen, { x: e.clientX, y: e.clientY })) return
        d.active = true
        latest.current.onStart()
      }
      const point = floorPoint(e)
      if (point) latest.current.onMove({ x: point.x + d.offset.x, z: point.z + d.offset.z })
    },
    onPointerUp(e: ThreeEvent<PointerEvent>) {
      if (drag.current?.pointerId !== e.pointerId) return
      ;(e.target as unknown as Element).releasePointerCapture(e.pointerId)
      finish()
    },
    onLostPointerCapture: finish,
  }
}
