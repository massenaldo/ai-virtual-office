import { describe, expect, it } from 'vitest'
import type { Box } from './architecture'
import { mergeBoxes } from './roomGeometry'

const a: Box = { x: 0, y: 0.5, z: 0, w: 1, h: 1, d: 1 }
const b: Box = { x: 3, y: 1, z: 0, w: 1, h: 2, d: 1 }
const c: Box = { x: -2, y: 1, z: 2, w: 0.5, h: 2, d: 3 }

describe('mergeBoxes', () => {
  it('returns null for no boxes', () => {
    expect(mergeBoxes([])).toBeNull()
  })

  it('places and sizes every box', () => {
    const geometry = mergeBoxes([a, b])!
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.toArray()).toEqual([-0.5, 0, -0.5])
    expect(geometry.boundingBox!.max.toArray()).toEqual([3.5, 2, 0.5])
  })

  it('keeps all faces, only the top face, or every face but the top', () => {
    expect(mergeBoxes([a, b, c])!.index!.count).toBe(108)
    expect(mergeBoxes([a, b, c], 'top')!.index!.count).toBe(18)
    expect(mergeBoxes([a, b, c], 'sides')!.index!.count).toBe(90)
  })

  it('keeps only upward-facing triangles for the top face', () => {
    const geometry = mergeBoxes([a, b, c], 'top')!
    const normals = geometry.getAttribute('normal')
    const index = geometry.index!
    for (let i = 0; i < index.count; i++) expect([normals.getX(index.getX(i)), normals.getY(index.getX(i)), normals.getZ(index.getX(i))]).toEqual([0, 1, 0])
  })
})
