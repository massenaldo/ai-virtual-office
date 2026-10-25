import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import type { Furniture, OfficeLayout } from './types'
import { findIssues } from './validation'

const withFurniture = (...items: Furniture[]): OfficeLayout => ({ ...createDefaultLayout(), rooms: [], furniture: items })
const item = (id: string, type: Furniture['type'], x = 0, z = 0): Furniture => ({ id, type, x, z, rotation: 0, roomId: null })

describe('findIssues', () => {
  it('reports nothing for the default layout', () => {
    expect(findIssues(createDefaultLayout()).size).toBe(0)
  })

  it('flags two desks on the same spot on both items', () => {
    const issues = findIssues(withFurniture(item('a', 'desk'), item('b', 'desk')))
    expect(issues.get('a')?.[0]).toMatchObject({ code: 'furniture-overlap', otherId: 'b' })
    expect(issues.get('b')?.[0]).toMatchObject({ code: 'furniture-overlap', otherId: 'a' })
  })

  it('allows a chair tucked into a desk and a monitor on a desk', () => {
    expect(findIssues(withFurniture(item('d', 'desk'), item('c', 'chair', 0, 0.3), item('m', 'monitor'))).size).toBe(0)
  })

  it('flags overlapping rooms', () => {
    const l = createDefaultLayout()
    l.rooms[1] = { ...l.rooms[1], x: l.rooms[0].x }
    expect(findIssues(l).get(l.rooms[0].id)?.[0].code).toBe('room-overlap')
  })

  it('flags anything outside the office bounds', () => {
    expect(findIssues(withFurniture(item('p', 'plant', 12.4, 0))).get('p')?.[0].code).toBe('out-of-bounds')
  })
})
