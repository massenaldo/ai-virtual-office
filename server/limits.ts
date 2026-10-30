export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`
}

/** The longest prefix that fits in maxBytes of UTF-8 without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch)
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return { text: out, truncated: true }
}

export const messageTruncatedMarker = (limit: number) => `\n[message truncated at ${formatBytes(limit)}]`
export const outputLimitMarker = (limit: number) => `\n[output limit reached at ${formatBytes(limit)}; later messages are dropped]`
