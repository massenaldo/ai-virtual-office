import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { labelAnchor, screenPosition } from './labels'

const room = { x: 2, z: -3, wallHeight: 2.5 }

describe('labelAnchor', () => {
  it('floats above the walls in 3D and just above the floor in floor plan', () => {
    expect(labelAnchor(room, false).toArray()).toEqual([2, 2.72, -3])
    expect(labelAnchor(room, true).toArray()).toEqual([2, 0.3, -3])
  })
})

describe('screenPosition', () => {
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const size = { width: 800, height: 400 }

  it('maps the point the camera looks at to the centre of the canvas', () => {
    expect(screenPosition(new THREE.Vector3(0, 0, 0), camera, size)).toEqual({ x: 400, y: 200, visible: true })
  })

  it('puts points above the centre higher on screen', () => {
    const p = screenPosition(new THREE.Vector3(0, 1, 0), camera, size)
    expect(p.y).toBeLessThan(200)
    expect(p.visible).toBe(true)
  })

  it('hides points behind the camera', () => {
    expect(screenPosition(new THREE.Vector3(0, 0, 20), camera, size).visible).toBe(false)
  })
})
