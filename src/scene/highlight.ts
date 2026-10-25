export const HIGHLIGHT = { selected: '#4f8cff', hover: '#9cc2ff', invalid: '#e5484d' }

/** Outline style for an object in the editor, or null when it needs none. Invalid placement always wins. */
export function highlightFor(s: { editing: boolean; selected: boolean; hovered: boolean; invalid: boolean }): { color: string; width: number } | null {
  if (!s.editing) return null
  const width = s.selected ? 3 : 2
  if (s.invalid) return { color: HIGHLIGHT.invalid, width }
  if (s.selected) return { color: HIGHLIGHT.selected, width }
  if (s.hovered) return { color: HIGHLIGHT.hover, width }
  return null
}
