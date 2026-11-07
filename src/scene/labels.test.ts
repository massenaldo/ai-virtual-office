import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { labelAnchor, markerAnchor, markerText, screenPosition } from './labels'

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

describe('markerAnchor', () => {
  it('floats above a desk in 3D and just above the floor in plan', () => {
    expect(markerAnchor({ x: 1, z: 2, seated: true }, false).toArray()).toEqual([1, 1.45, 2])
    expect(markerAnchor({ x: 1, z: 2, seated: true }, true).toArray()).toEqual([1, 0.35, 2])
  })

  it('floats higher over a character who is standing', () => {
    expect(markerAnchor({ x: 1, z: 2, seated: false }, false).toArray()).toEqual([1, 1.9, 2])
    expect(markerAnchor({ x: 1, z: 2, seated: false }, true).toArray()).toEqual([1, 0.35, 2])
  })
})

describe('markerText', () => {
  it('is the name alone with no presence label', () => expect(markerText('Atlas', null, null)).toBe('Atlas'))
  it('adds the presence label after a dot', () => expect(markerText('Atlas', 'On lunch', null)).toBe('Atlas · On lunch'))
  it('keeps the praying label exact', () => expect(markerText('Atlas', 'Praying', null)).toBe('Atlas · Praying'))
  it('a task phase wins over the presence label', () => expect(markerText('Atlas', 'On lunch', 'starting')).toBe('Atlas'))
})
