import { describe, expect, it } from 'vitest'
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
