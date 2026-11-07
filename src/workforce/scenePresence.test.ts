import { describe, expect, it, vi } from 'vitest'
import type { Presence } from '../office/presence'
import type { SceneCharacter } from '../scene/characterInstances'
import { createPresenceSource } from './scenePresence'

const character = (id: string, seated = true): SceneCharacter => ({ id, deskId: `d-${id}`, x: 1, z: 2, rotation: 90, seated, status: 'idle', doneAt: null, accent: '#fff' })
const presence = (o: Partial<Presence>): Presence => ({ state: 'at-desk', x: 1, z: 2, rotation: 90, pose: 'sit', label: null, bubble: false, ...o })
const clock = (now: number, routine = true) => ({ now: () => now, routine })

describe('createPresenceSource', () => {
  it('asks the routine at the office time and maps each state to an activity', () => {
    const presenceAt = vi.fn()
    const source = createPresenceSource({ presenceAt }, clock(1234), [character('a')])
    const expected: [Presence['state'], string][] = [['at-desk', 'idle'], ['walking', 'idle'], ['chatting', 'chat'], ['coffee', 'coffee'], ['lunch', 'eat'], ['praying', 'pray']]
    for (const [state, activity] of expected) {
      presenceAt.mockReturnValue(presence({ state, pose: 'stand', x: 4, z: 5, rotation: 30, label: 'L', bubble: state === 'chatting' }))
      expect(source('a')).toEqual({ x: 4, z: 5, rotation: 30, pose: 'stand', activity, label: 'L', bubble: state === 'chatting' })
      expect(presenceAt).toHaveBeenLastCalledWith('a', 1234)
    }
  })

  it('shows the praying label exactly as the routine gives it', () => {
    const source = createPresenceSource({ presenceAt: () => presence({ state: 'praying', pose: 'stand', label: 'Praying' }) }, clock(0), [character('a')])
    expect(source('a')?.label).toBe('Praying')
  })

  it('a seated break at the desk keeps its label but only eating stays an activity', () => {
    const at = (state: Presence['state']) => createPresenceSource({ presenceAt: () => presence({ state, label: 'x' }) }, clock(0), [character('a')])('a')
    expect(at('coffee')?.activity).toBe('idle')
    expect(at('lunch')?.activity).toBe('eat')
    expect(at('coffee')?.label).toBe('x')
  })

  it('is null for an agent the routine does not know', () => {
    expect(createPresenceSource({ presenceAt: () => null }, clock(0), [character('a')])('a')).toBeNull()
  })

  it('with the routine off every character sits at its seat with no label, and the routine is not asked', () => {
    const presenceAt = vi.fn()
    const source = createPresenceSource({ presenceAt }, clock(0, false), [character('a'), character('b', false)])
    expect(source('a')).toEqual({ x: 1, z: 2, rotation: 90, pose: 'sit', activity: 'idle', label: null, bubble: false })
    expect(source('b')?.pose).toBe('stand')
    expect(source('nobody')).toBeNull()
    expect(presenceAt).not.toHaveBeenCalled()
  })

  it('with no routine at all it also keeps everyone at the seat', () => {
    expect(createPresenceSource(null, clock(0), [character('a')])('a')?.label).toBeNull()
  })
})
