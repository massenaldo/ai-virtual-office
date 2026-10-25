import { describe, expect, it } from 'vitest'
import { isTypingTarget, matchShortcut } from './shortcuts'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}, target: unknown = { tagName: 'BODY' }) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, ...mods, target })

describe('isTypingTarget', () => {
  it('recognises form fields and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('matchShortcut', () => {
  it('maps undo and redo on Mac and other platforms', () => {
    expect(matchShortcut(key('z', { metaKey: true }), true)).toBe('undo')
    expect(matchShortcut(key('z', { ctrlKey: true }), true)).toBe('undo')
    expect(matchShortcut(key('Z', { ctrlKey: true, shiftKey: true }), true)).toBe('redo')
    expect(matchShortcut(key('z', { metaKey: true, shiftKey: true }), true)).toBe('redo')
  })

  it('maps delete, backspace and escape', () => {
    expect(matchShortcut(key('Delete'), true)).toBe('delete')
    expect(matchShortcut(key('Backspace'), true)).toBe('delete')
    expect(matchShortcut(key('Escape'), true)).toBe('escape')
  })

  it('leaves keys alone while typing in a field', () => {
    expect(matchShortcut(key('Backspace', {}, { tagName: 'INPUT' }), true)).toBeNull()
    expect(matchShortcut(key('z', { metaKey: true }, { tagName: 'TEXTAREA' }), true)).toBeNull()
  })

  it('does nothing outside edit mode', () => {
    expect(matchShortcut(key('Delete'), false)).toBeNull()
    expect(matchShortcut(key('z', { metaKey: true }), false)).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(matchShortcut(key('a'), true)).toBeNull()
    expect(matchShortcut(key('z'), true)).toBeNull()
  })
})
