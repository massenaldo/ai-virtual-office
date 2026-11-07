import { stableHash } from './furnitureModels'

export type CharacterBody = 'man' | 'woman'
export type CharacterHair = 'short' | 'side' | 'bun' | 'long' | 'hijab'
export type CharacterCut = 'shirt' | 'blazer' | 'sweater' | 'tunic'
export type CharacterLook = { body: CharacterBody; skin: string; hair: CharacterHair; hairColor: string; cut: CharacterCut; clothing: string; trousers: string }

const SKINS = ['#f3d5b5', '#e8b98f', '#d19a6e', '#a8704a', '#7a4b32', '#5a3624']
const HAIR_COLORS = ['#1c1410', '#3b2417', '#6b4a2f', '#a67b4b', '#8c8c8c', '#2b2b33']
const CLOTHING = ['#e8e4dc', '#c9d3dc', '#9fb1bf', '#4a5568', '#2f3e52', '#7b8794', '#b9a99a', '#5f7a6b']
const TROUSERS = ['#2b2f3a', '#3d4452', '#5a5348', '#1f2430']

// Per-body lists. Hijab is one entry among several for women and is never first; men have none.
const HAIR: Record<CharacterBody, CharacterHair[]> = {
  man: ['short', 'short', 'side', 'short'],
  woman: ['long', 'bun', 'side', 'hijab', 'long', 'bun', 'hijab', 'side', 'long', 'bun'],
}
const CUTS: Record<CharacterBody, CharacterCut[]> = {
  man: ['shirt', 'blazer', 'sweater', 'shirt'],
  woman: ['tunic', 'blazer', 'sweater', 'shirt'],
}

/** FNV-1a's low bits track the last characters only, so mix the high bits down before taking a remainder. */
const roll = (id: string, salt: string, size: number): number => {
  const h = stableHash(`${id}:${salt}`)
  return (Math.imul(h ^ (h >>> 15), 2246822519) >>> 8) % size
}
const pick = <T>(list: readonly T[], id: string, salt: string): T => list[roll(id, salt, list.length)]

/**
 * How an agent looks, from its ID alone. Each trait uses its own salt so traits do not move together. Appearance says nothing
 * about an agent's prayer setting, so nothing but the ID is read.
 */
export function characterLook(id: string): CharacterLook {
  const body: CharacterBody = roll(id, 'body', 2) === 0 ? 'man' : 'woman'
  return {
    body,
    skin: pick(SKINS, id, 'skin'),
    hair: pick(HAIR[body], id, 'hair'),
    hairColor: pick(HAIR_COLORS, id, 'hairColor'),
    cut: pick(CUTS[body], id, 'cut'),
    clothing: pick(CLOTHING, id, 'clothing'),
    trousers: pick(TROUSERS, id, 'trousers'),
  }
}
