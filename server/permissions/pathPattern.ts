import { PATTERN_MAX_CHARS } from './types'

// Patterns are workspace-relative globs: `*` and `?` stay inside one segment, a whole segment `**` matches zero or more
// segments. No regular expressions and a memoised matcher, so the cost is bounded by pattern length times path length.

const CONTROL = /[\u0000-\u001f\u007f]/
const FORBIDDEN = /[\\{}[\]()!@+~]/

export function isValidPathPattern(pattern: string): boolean {
  if (pattern === '' || pattern.length > PATTERN_MAX_CHARS) return false
  if (CONTROL.test(pattern) || FORBIDDEN.test(pattern) || pattern.includes('..')) return false
  if (pattern.startsWith('/') || pattern.endsWith('/')) return false
  return pattern.split('/').every((segment) => segment !== '' && segment !== '.')
}

/** `*` and `?` inside one segment, iterative with a single backtrack point. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++ }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = t }
    else if (star !== -1) { p = star + 1; t = ++mark }
    else return false
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

export function matchesPathPattern(pattern: string, relative: string, caseSensitive: boolean): boolean {
  const fold = (s: string) => (caseSensitive ? s.normalize('NFC') : s.normalize('NFC').toLowerCase())
  const pat = fold(pattern).split('/')
  const path = fold(relative).split('/')
  const memo = new Map<number, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let result: boolean
    if (i === pat.length) result = j === path.length
    // A trailing `**` needs at least one segment (`src/**` is the contents of src, not src itself); elsewhere it may match none.
    else if (pat[i] === '**') result = i === pat.length - 1 ? j < path.length : go(i + 1, j) || (j < path.length && go(i, j + 1))
    else result = j < path.length && segmentMatches(pat[i], path[j]) && go(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}

/**
 * True when `dir` is the pattern's own target or a directory-prefix of it: something at or below `dir` could match
 * `pattern` (`.` and the empty path are the workspace root and are a prefix of every pattern). Used by deny rules so a
 * search that starts at a parent folder cannot slip past a rule on a path below it. Conservative: a `**` segment, or
 * any segment that fits, counts as able to match. Always case-insensitive.
 */
export function patternReachableFrom(pattern: string, dir: string): boolean {
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  const pat = fold(pattern).split('/')
  const segs = fold(dir).split('/').filter((s) => s !== '' && s !== '.')
  const memo = new Map<number, boolean>()
  const go = (i: number, j: number): boolean => {
    if (j === segs.length) return true
    if (i === pat.length) return false
    const key = i * (segs.length + 1) + j
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const result = pat[i] === '**' ? go(i + 1, j) || go(i, j + 1) : segmentMatches(pat[i]!, segs[j]!) && go(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}
