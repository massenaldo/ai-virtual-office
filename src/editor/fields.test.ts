import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../layout/defaultLayout'
import { deletionPrompt, parseNumberInput } from './fields'

describe('parseNumberInput', () => {
  it('parses decimals with a dot or a comma', () => {
    expect(parseNumberInput(' 4.5 ')).toBe(4.5)
    expect(parseNumberInput('-1,25')).toBe(-1.25)
  })

  it('rejects empty and non-numeric text', () => {
    expect(parseNumberInput('')).toBeNull()
    expect(parseNumberInput('abc')).toBeNull()
    expect(parseNumberInput('1e999')).toBeNull()
  })
})

describe('deletionPrompt', () => {
  const layout = createDefaultLayout()

  it('asks before deleting a room that still has furniture', () => {
    const p = deletionPrompt(layout, { kind: 'room', id: 'room-ceo-office' })
    expect(p?.needsConfirm).toBe(true)
    expect(p?.message).toContain('6 furniture items')
  })

  it('deletes empty rooms and single furniture items without asking', () => {
    expect(deletionPrompt(layout, { kind: 'room', id: 'room-qa' })?.needsConfirm).toBe(false)
    expect(deletionPrompt(layout, { kind: 'furniture', id: 'plant-01' })?.needsConfirm).toBe(false)
  })

  it('returns null when nothing deletable is selected', () => {
    expect(deletionPrompt(layout, null)).toBeNull()
    expect(deletionPrompt(layout, { kind: 'room', id: 'missing' })).toBeNull()
  })
})
