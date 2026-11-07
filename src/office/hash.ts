/** FNV-1a over the text, as an unsigned 32-bit integer. The same text always gives the same number. */
export function stableHash(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}
