import { describe, expect, it } from 'vitest'
import { isProtectedAbsolute, isSensitiveRelative } from './sensitivePaths'

describe('isSensitiveRelative', () => {
  it.each(['.env', '.env.local', 'sub/.ENV', '.git/config', 'a/.git', 'key.pem', 'id_rsa', 'id_ed25519.pub', '.ssh/config', '.aws/credentials', '.npmrc', '.netrc', 'credentials.json', 'a/KEY.PEM', 'x.p12', 'x.pfx', 'x.key'])('refuses %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(true)
  })
  it.each(['src/env.ts', 'environment.md', 'gitignore.txt', 'a/b.txt', 'notes.md'])('allows %s', (p) => {
    expect(isSensitiveRelative(p)).toBe(false)
  })
})

describe('isProtectedAbsolute', () => {
  it('matches inside a root only', () => {
    expect(isProtectedAbsolute('/x/data/api-token', ['/x/data'])).toBe(true)
    expect(isProtectedAbsolute('/x/data', ['/x/data'])).toBe(true)
    expect(isProtectedAbsolute('/x/database', ['/x/data'])).toBe(false)
    expect(isProtectedAbsolute('/x/data/a', [])).toBe(false)
  })
})
