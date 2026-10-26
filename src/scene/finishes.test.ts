import { describe, expect, it } from 'vitest'
import { floorFinishFor, partitionStyle } from './finishes'

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

describe('partitionStyle', () => {
  it('glazes one side of the executive office and meeting room', () => {
    expect(partitionStyle('meeting')).toEqual({ left: 'solid', right: 'glass' })
    expect(partitionStyle('executive')).toEqual({ left: 'solid', right: 'glass' })
  })

  it('keeps team rooms solid on both sides', () => {
    expect(partitionStyle('backend')).toEqual({ left: 'solid', right: 'solid' })
  })
})
