import { describe, expect, it } from 'vitest'
import { characterLook } from './characterLook'

const looks = Array.from({ length: 2000 }, (_, i) => characterLook(`agent-${i}`))
const women = looks.filter((l) => l.body === 'woman')
const men = looks.filter((l) => l.body === 'man')
const share = (n: number, of: number) => n / of

describe('characterLook', () => {
  it('is stable for an id', () => {
    expect(characterLook('agent-demo-pm')).toEqual(characterLook('agent-demo-pm'))
  })

  it('has men and women, each 35-65%', () => {
    expect(share(women.length, looks.length)).toBeGreaterThan(0.35)
    expect(share(women.length, looks.length)).toBeLessThan(0.65)
    expect(men.length + women.length).toBe(looks.length)
  })

  it('hijab is on some women, between 15% and 45% of them, and on no men', () => {
    const hijab = women.filter((l) => l.hair === 'hijab').length
    expect(share(hijab, women.length)).toBeGreaterThan(0.15)
    expect(share(hijab, women.length)).toBeLessThan(0.45)
    expect(men.some((l) => l.hair === 'hijab')).toBe(false)
  })

  it('uses every skin, hair and cut option', () => {
    expect(new Set(looks.map((l) => l.skin)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(looks.map((l) => l.hair))).toEqual(new Set(['short', 'side', 'bun', 'long', 'hijab']))
    expect(new Set(looks.map((l) => l.cut))).toEqual(new Set(['shirt', 'blazer', 'sweater', 'tunic']))
    expect(new Set(looks.map((l) => l.clothing)).size).toBeGreaterThan(3)
    expect(new Set(looks.map((l) => l.trousers)).size).toBeGreaterThan(1)
  })

  it('does not tie skin to body or hair', () => {
    const skins = new Set(women.map((l) => l.skin))
    expect(skins.size).toBe(new Set(looks.map((l) => l.skin)).size)
  })

  it('takes only the id', () => {
    expect(characterLook.length).toBe(1)
  })
})
