export const HIGHLIGHT = { selected: '#4f8cff', hover: '#9cc2ff', invalid: '#e5484d', agent: '#a89af5' }

/**
 * Outline style for an object, or null when it needs none. In the editor, invalid placement always wins. Outside
 * the editor only the workforce cues apply: the selected agent's desk, then a hovered clickable desk.
 */
export function highlightFor(s: { editing: boolean; selected: boolean; hovered: boolean; invalid: boolean; agent?: boolean; deskHover?: boolean }): { color: string; width: number } | null {
  if (!s.editing) {
    if (s.agent) return { color: HIGHLIGHT.agent, width: 3 }
    if (s.deskHover) return { color: HIGHLIGHT.hover, width: 2 }
    return null
  }
  const width = s.selected ? 3 : 2
  if (s.invalid) return { color: HIGHLIGHT.invalid, width }
  if (s.selected) return { color: HIGHLIGHT.selected, width }
  if (s.hovered) return { color: HIGHLIGHT.hover, width }
  return null
}
