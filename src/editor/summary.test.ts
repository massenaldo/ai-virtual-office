import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { deleteRoom } from '../layout/operations'
import { summarizeLayout } from './summary'

describe('summarizeLayout', () => {
  it('counts rooms and all desks', () => {
    const s = summarizeLayout(createDefaultLayout())
    expect(s.roomCount).toBe(13)
    expect(s.deskCount).toBe(14)
  })

  it('lists each department in layout order with the desks inside its rooms', () => {
    const s = summarizeLayout(createDefaultLayout())
    expect(s.departments[0]).toEqual({ id: 'executive', label: 'Executive', color: '#9c7c59', desks: 2 })
    expect(s.departments.find((d) => d.id === 'backend')?.desks).toBe(2)
    expect(s.departments.find((d) => d.id === 'qa')?.desks).toBe(0)
    expect(s.departments).toHaveLength(10)
  })

  it('counts break rooms as rooms but leaves them out of the departments', () => {
    const s = summarizeLayout(createDefaultLayout())
    expect(s.roomCount).toBe(13)
    expect(s.departments.map((d) => d.id)).not.toContain('kitchen')
    expect(s.departments.map((d) => d.id)).not.toContain('dining')
    expect(s.departments.map((d) => d.id)).not.toContain('prayer')
  })

  it('follows layout changes', () => {
    const s = summarizeLayout(deleteRoom(createDefaultLayout(), 'room-ceo-office'))
    expect(s.roomCount).toBe(12)
    expect(s.deskCount).toBe(12)
    expect(s.departments.some((d) => d.id === 'executive')).toBe(false)
  })
})
