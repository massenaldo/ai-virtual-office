import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { accentMaterial, floorMaterial, sharedMaterials } from './materials'

describe('shared materials', () => {
  it('creates each material once and reuses it', () => {
    expect(sharedMaterials()).toBe(sharedMaterials())
    expect(floorMaterial('oak')).toBe(sharedMaterials().oak)
  })

  it('caches accent materials per colour', () => {
    expect(accentMaterial('#7898a7')).toBe(accentMaterial('#7898a7'))
    expect(accentMaterial('#7898a7')).not.toBe(accentMaterial('#8daab7'))
  })

  it('makes glass see-through without hiding what is behind it', () => {
    const { glass } = sharedMaterials()
    expect(glass.transparent).toBe(true)
    expect(glass.depthWrite).toBe(false)
  })

  it('skips procedural textures where there is no DOM', () => {
    expect(sharedMaterials().concrete.map).toBeNull()
  })
})

describe('furniture materials', () => {
  it('provides every furniture material once', () => {
    const m = sharedMaterials()
    for (const key of ['oakVeneer', 'walnut', 'fabric', 'plastic', 'screen', 'chrome', 'cabinetWhite'] as const) expect(m[key]).toBeDefined()
    expect(m.walnut).not.toBe(m.oakVeneer)
  })

  it('gives screens a soft glow', () => {
    expect(sharedMaterials().screen.emissiveIntensity).toBeGreaterThan(0)
  })
})

describe('tower floor slab', () => {
  const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l

  it('the slab top is clearly darker than the 3D background', () => {
    expect(lightness(sharedMaterials().slabTop.color)).toBeLessThan(lightness(new THREE.Color('#e6e3de')) - 0.08)
  })

  it('the slab edge is darker than its top', () => {
    const m = sharedMaterials()
    expect(lightness(m.slabEdge.color)).toBeLessThan(lightness(m.slabTop.color))
  })
})
