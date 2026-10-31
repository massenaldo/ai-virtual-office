import { describe, expect, it } from 'vitest'
import { isValidPathPattern, matchesPathPattern } from './pathPattern'

describe('isValidPathPattern', () => {
  it.each(['src/**', '*.md', 'docs/*/index.md', 'a?c.txt', '**/*.ts'])('accepts %s', (p) => {
    expect(isValidPathPattern(p)).toBe(true)
  })

  it.each(['', '/etc/**', '~/x', '../x', 'a/../b', 'a\\b', 'a//b', 'a/', '{a,b}', '[ab]', '(x)', 'a\u0000b', 'x'.repeat(201)])('rejects %j', (p) => {
    expect(isValidPathPattern(p)).toBe(false)
  })
})

describe('matchesPathPattern', () => {
  it('lets ** match zero or more whole segments', () => {
    expect(matchesPathPattern('src/**', 'src/a.ts', true)).toBe(true)
    expect(matchesPathPattern('src/**', 'src/a/b', true)).toBe(true)
    expect(matchesPathPattern('src/**', 'src', true)).toBe(false)
    expect(matchesPathPattern('**/*.ts', 'x.ts', true)).toBe(true)
    expect(matchesPathPattern('**/*.ts', 'a/b/x.ts', true)).toBe(true)
  })

  it('keeps * inside one segment and ? to one character', () => {
    expect(matchesPathPattern('*.md', 'a.md', true)).toBe(true)
    expect(matchesPathPattern('*.md', 'a/b.md', true)).toBe(false)
    expect(matchesPathPattern('a?c.txt', 'abc.txt', true)).toBe(true)
    expect(matchesPathPattern('a?c.txt', 'ac.txt', true)).toBe(false)
  })

  it('matches case-insensitively only when asked', () => {
    expect(matchesPathPattern('secrets/**', 'SECRETS/key', false)).toBe(true)
    expect(matchesPathPattern('secrets/**', 'SECRETS/key', true)).toBe(false)
  })

  it('treats composed and decomposed Unicode as the same name', () => {
    expect(matchesPathPattern('café/*', 'café/x', true)).toBe(true)
  })

  it('finishes a pathological pattern quickly', () => {
    const pattern = `${Array(40).fill('**').join('/')}/z`
    expect(pattern.length).toBeLessThan(200)
    const path = Array(60).fill('a').join('/')
    const start = performance.now()
    expect(matchesPathPattern(pattern, path, true)).toBe(false)
    expect(performance.now() - start).toBeLessThan(100)
  })
})
