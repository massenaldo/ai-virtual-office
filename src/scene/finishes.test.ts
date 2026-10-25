import { describe, expect, it } from 'vitest'
import { floorFinishFor } from './finishes'

describe('floorFinishFor', () => {
  it('gives executive and meeting rooms oak floors', () => {
    expect(floorFinishFor('executive')).toBe('oak')
    expect(floorFinishFor('meeting')).toBe('oak')
  })

  it('gives the server room an epoxy floor', () => {
    expect(floorFinishFor('devops')).toBe('epoxy')
  })

  it('carpets team rooms', () => {
    expect(floorFinishFor('backend')).toBe('carpet')
    expect(floorFinishFor('qa')).toBe('carpet')
  })
})
