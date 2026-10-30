import { describe, expect, it } from 'vitest'
import { HIGHLIGHT, highlightFor } from './highlight'

describe('highlightFor', () => {
  it('shows nothing for plain objects or outside edit mode', () => {
    expect(highlightFor({ editing: true, selected: false, hovered: false, invalid: false })).toBeNull()
    expect(highlightFor({ editing: false, selected: true, hovered: true, invalid: true })).toBeNull()
  })

  it('marks invalid placement in red even when selected', () => {
    expect(highlightFor({ editing: true, selected: true, hovered: false, invalid: true })).toEqual({ color: HIGHLIGHT.invalid, width: 3 })
    expect(highlightFor({ editing: true, selected: false, hovered: false, invalid: true })).toEqual({ color: HIGHLIGHT.invalid, width: 2 })
  })

  it('prefers the selected style over hover', () => {
    expect(highlightFor({ editing: true, selected: true, hovered: true, invalid: false })).toEqual({ color: HIGHLIGHT.selected, width: 3 })
    expect(highlightFor({ editing: true, selected: false, hovered: true, invalid: false })).toEqual({ color: HIGHLIGHT.hover, width: 2 })
  })
})

describe('agent and desk hover highlights', () => {
  const base = { editing: false, selected: false, hovered: false, invalid: false }
  it('agent highlight shows outside edit mode', () => {
    expect(highlightFor({ ...base, agent: true })).toEqual({ color: HIGHLIGHT.agent, width: 3 })
    expect(HIGHLIGHT.agent).toBe('#a89af5')
  })
  it('desk hover shows outside edit mode only without agent', () => {
    expect(highlightFor({ ...base, deskHover: true })).toEqual({ color: HIGHLIGHT.hover, width: 2 })
    expect(highlightFor({ ...base, deskHover: true, agent: true })).toEqual({ color: HIGHLIGHT.agent, width: 3 })
    expect(highlightFor(base)).toBeNull()
  })
  it('edit mode ignores the agent flags', () => {
    expect(highlightFor({ ...base, editing: true, agent: true, deskHover: true })).toBeNull()
    expect(highlightFor({ ...base, editing: true, selected: true, agent: true })).toEqual({ color: HIGHLIGHT.selected, width: 3 })
  })
})
