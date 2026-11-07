import { describe, expect, it } from 'vitest'
import { characterLook } from './characterLook'
import { CHARACTER_PARTS, partColor } from './characterRig'
import { buildPartInstances, type SceneCharacter } from './characterInstances'

const character = (id: string, deskId = `desk-${id}`): SceneCharacter => ({ id, deskId, x: 0, z: 0, rotation: 0, seated: true, status: 'idle', doneAt: null, accent: '#7898a7' })

describe('buildPartInstances', () => {
  it('no characters gives no instances', () => {
    expect(buildPartInstances([])).toEqual([])
  })

  it('each character appears once in each entry it uses and never in entries it does not', () => {
    const characters = [character('a'), character('b'), character('c')]
    const groups = buildPartInstances(characters)
    characters.forEach((c, characterIndex) => {
      const look = characterLook(c.id)
      for (const entry of CHARACTER_PARTS) {
        const color = partColor(entry.part, look, c.accent)
        const found = groups.flatMap((g) => g.instances).filter((i) => i.characterIndex === characterIndex && i.entry === entry)
        expect(found).toHaveLength(color === null ? 0 : 1)
        if (color !== null) expect(found[0].color).toBe(color)
      }
    })
  })

  it('holds one geometry per group, shared by limbs, and every instance belongs to a group with its geometry', () => {
    const groups = buildPartInstances([character('a'), character('b')])
    expect(new Set(groups.map((g) => g.geometry)).size).toBe(groups.length)
    for (const g of groups) for (const i of g.instances) expect(i.entry.geometry).toBe(g.geometry)
    expect(groups.length).toBeLessThan(CHARACTER_PARTS.length)
  })

  it('a group casts a shadow if any of its entries does', () => {
    for (const g of buildPartInstances([character('a')])) expect(g.castShadow).toBe(g.instances.some((i) => i.entry.castShadow))
  })

  it('the number of groups does not depend on the number of characters using the same parts', () => {
    const one = buildPartInstances([character('same')])
    const many = buildPartInstances(Array.from({ length: 14 }, (_, i) => character('same', `desk-${i}`)))
    expect(many).toHaveLength(one.length)
    expect(many[0].instances.length).toBe(one[0].instances.length * 14)
  })
})
