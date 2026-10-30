import { describe, expect, it } from 'vitest'
import { formatBytes, messageTruncatedMarker, outputLimitMarker, truncateUtf8 } from './limits'

describe('formatBytes', () => {
  it('uses bytes under 1 KB and whole kilobytes above', () => {
    expect(formatBytes(16)).toBe('16 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(32768)).toBe('32 KB')
    expect(formatBytes(262144)).toBe('256 KB')
  })
})

describe('truncateUtf8', () => {
  it('never splits a code point', () => {
    expect(truncateUtf8('héllo', 2)).toEqual({ text: 'h', truncated: true })
    expect(truncateUtf8('héllo', 3)).toEqual({ text: 'hé', truncated: true })
    expect(truncateUtf8('a😀b', 4)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('a😀b', 5)).toEqual({ text: 'a😀', truncated: true })
  })

  it('leaves text that fits untouched', () => {
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(truncateUtf8('', 0)).toEqual({ text: '', truncated: false })
  })
})

describe('markers', () => {
  it('state the limit in readable units', () => {
    expect(messageTruncatedMarker(16)).toBe('\n[message truncated at 16 B]')
    expect(outputLimitMarker(262144)).toBe('\n[output limit reached at 256 KB; later messages are dropped]')
  })
})
