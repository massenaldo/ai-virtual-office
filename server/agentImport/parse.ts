import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX } from '../../src/workforce/types'
import { MODEL_NAME_PATTERN, NAME_MAX, ROLE_MAX } from '../../src/workforce/operations'
import { redactSecrets } from '../redact'
import { hasUnsafeText } from '../toolPolicy'

/**
 * An agent file is untrusted text. Only `name`, `description` and `model` are read; every other key is listed by name
 * and otherwise ignored, so a file can grant nothing (no tools, no permission mode). Nothing here runs or follows anything.
 */
export type ParsedAgentFile = {
  name: string
  description: string
  model: string | null
  instructions: string
  ignoredFields: string[]
  descriptionCut: boolean
  secretsMasked: boolean
}

type Parsed = { ok: true; agent: ParsedAgentFile } | { ok: false; error: string }

const ACCEPTED = new Set(['name', 'description', 'model'])
const KEY_NAME = /^[A-Za-z0-9_-]{1,40}$/
const BLOCK_HEADER = /^[>|][+-]?$/
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const MAX_IGNORED_LISTED = 50

/** Only spaces and tabs count as blanks around a marker; other Unicode whitespace does not. */
const stripBlanks = (line: string): string => line.replace(/[ \t]+$/, '')
const NOT_A_KEY = 'The front matter has a line that is not a "key: value" pair with a plain key (letters, digits, dashes and underscores), so it was not imported.'
const fail = (error: string): Parsed => ({ ok: false, error })
const indentOf = (line: string): number => line.length - line.trimStart().length

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }

/** Removes one pair of quotes. In a value (not a key) a double-quoted text also decodes \n, \t, \" and \\ and nothing else. */
function unquote(value: string, decode = false): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    const inner = v.slice(1, -1)
    return decode ? inner.replace(/\\([nt"\\])/g, (_m, c: string) => ESCAPES[c]!) : inner
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

const PICTOGRAPH = /^\p{Extended_Pictographic}$/u
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u
const KEYCAP_BASE = /^[0-9#*]$/
const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * The first character a file may not carry, as "Line N has ...", or null. The shared check in toolPolicy refuses every invisible
 * character; here, and only here, a well-formed emoji sequence is let through: U+FE0F straight after a pictograph (or in a keycap),
 * and U+200D only between two pictographs. Anything else of that kind is refused.
 */
function unsafeCharacter(lines: Array<[number, string]>): string | null {
  for (const [no, text] of lines) {
    const chars = Array.from(text)
    // base: the last unit was a pictograph itself (U+FE0F and a skin tone may follow); mayJoin: a joiner may follow.
    let base = false
    let mayJoin = false
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!
      const cp = c.codePointAt(0)!
      let allowed = false
      let nextBase = false
      let nextJoin = false
      if (EMOJI_MODIFIER.test(c)) {
        if (base) { allowed = true; nextJoin = true }
      } else if (PICTOGRAPH.test(c)) { allowed = true; nextBase = true; nextJoin = true }
      else if (cp === 0xfe0f) {
        if (base) { allowed = true; nextJoin = true }
        else if (KEYCAP_BASE.test(chars[i - 1] ?? '') && chars[i + 1] === '\u20e3') allowed = true
      } else if (cp === 0x200d && mayJoin && PICTOGRAPH.test(chars[i + 1] ?? '') && !EMOJI_MODIFIER.test(chars[i + 1]!)) allowed = true
      if (!allowed && hasUnsafeText(c)) return `Line ${no} has ${ANY_CONTROL.test(c) ? 'a control character' : 'an invisible character'} (${hex(cp)}).`
      base = nextBase
      mayJoin = nextJoin
    }
  }
  return null
}

/** The value of one accepted key from its first-line text and its indented continuation lines. */
function valueOf(first: string, rest: string[]): string {
  const head = first.trim()
  const indents = rest.filter((l) => l.trim() !== '').map(indentOf)
  const base = indents.length > 0 ? Math.min(...indents) : 0
  const lines = rest.map((l) => (l.trim() === '' ? '' : l.slice(base).trimEnd()))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (BLOCK_HEADER.test(head)) {
    if (head.startsWith('|')) return lines.join('\n')
    // Folded: lines within a paragraph join with a space, blank lines separate paragraphs.
    return lines.join('\n').split(/\n{2,}/).map((p) => p.split('\n').join(' ')).join('\n')
  }
  const parts = [head, ...lines.filter((l) => l !== '')]
  return unquote(parts.length > 1 ? parts.filter((p) => p !== '').join(' ') : head, true)
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let out = text.slice(0, max)
  // Never leave half of a surrogate pair at the end.
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

export function parseAgentFile(text: string): Parsed {
  const all = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (stripBlanks(all[0] ?? '') !== '---') return fail('The file must start with a "---" line that opens the front matter.')
  const close = all.findIndex((l, i) => i > 0 && stripBlanks(l) === '---')
  if (close === -1) return fail('The front matter is never closed: add a "---" line after it.')

  const values = new Map<string, string>()
  const ignored: string[] = []
  let current: { key: string; first: string; rest: string[]; seen: Array<[number, string]> } | null = null
  const scanned: Array<[number, string]> = []
  const finish = () => {
    if (current && ACCEPTED.has(current.key)) {
      values.set(current.key, valueOf(current.first, current.rest))
      scanned.push(...current.seen)
    }
    current = null
  }
  for (const [offset, line] of all.slice(1, close).entries()) {
    const no = offset + 2
    const open = current as { rest: string[]; seen: Array<[number, string]> } | null
    // Only a # in column 0 is a comment; it leaves the open key open, so lines after it still belong to that key.
    if (line.startsWith('#')) continue
    const indented = line.startsWith(' ') || line.startsWith('\t')
    if (line.trim() === '') { open?.rest.push(line); open?.seen.push([no, line]); continue }
    if (indented) {
      if (!open) return fail(NOT_A_KEY)
      open.rest.push(line)
      open.seen.push([no, line])
      continue
    }
    // A column-0 list item, or a lone closing bracket, belongs to the key above it; with no key open it is refused.
    if (line === '-' || line.startsWith('- ') || /^[\]}][ \t]*$/.test(line)) {
      if (!open) return fail(NOT_A_KEY)
      open.rest.push(line)
      open.seen.push([no, line])
      continue
    }
    finish()
    const colon = line.indexOf(':')
    const key = colon === -1 ? '' : unquote(line.slice(0, colon))
    if (!KEY_NAME.test(key)) return fail(NOT_A_KEY)
    const first = line.slice(colon + 1)
    if (ACCEPTED.has(key)) {
      if (values.has(key)) return fail(`The "${key}" field appears more than once.`)
      // Reserve the slot so a second one is caught even before this value is finished.
      values.set(key, '')
    } else {
      // A key that looks like a secret is listed masked, never verbatim.
      const shown = redactSecrets(key)
      if (!ignored.includes(shown)) ignored.push(shown)
      if (ignored.length > MAX_IGNORED_LISTED) return fail(`The front matter has more than ${MAX_IGNORED_LISTED} other fields, so it was not imported.`)
    }
    current = { key, first, rest: [], seen: [[no, first]] }
  }
  finish()

  const bodyLines = all.slice(close + 1)
  const body = bodyLines.join('\n').trim()
  const unsafe = unsafeCharacter([...scanned, ...bodyLines.map((l, i): [number, string] => [close + 2 + i, l])])
  if (unsafe) return fail(unsafe)
  const rawName = (values.get('name') ?? '').trim()
  const rawDescription = (values.get('description') ?? '').trim()
  const rawModel = (values.get('model') ?? '').trim()

  if (!rawName) return fail('The file has no name: add a "name:" line to the front matter.')
  if (ANY_CONTROL.test(rawName)) return fail('The name must be a single line without tabs or control characters.')
  if (rawName.length > NAME_MAX) return fail(`The name must be ${NAME_MAX} characters or fewer.`)
  if (redactSecrets(rawModel) !== rawModel) return fail('The model looks like a secret, so the file was not imported.')
  if (rawModel && rawModel.toLowerCase() !== 'inherit' && !MODEL_NAME_PATTERN.test(rawModel)) return fail('The model is not a valid model name.')
  if (body.length > AGENT_INSTRUCTIONS_MAX) return fail(`The instructions are ${body.length} characters long; the limit is ${AGENT_INSTRUCTIONS_MAX}.`)

  let masked = false
  const mask = (v: string): string => {
    const r = redactSecrets(v)
    if (r !== v) masked = true
    return r
  }
  const name = mask(rawName)
  const described = mask(rawDescription)
  const instructions = mask(body)
  if (name.length > NAME_MAX) return fail(`The name must be ${NAME_MAX} characters or fewer.`)
  if (instructions.length > AGENT_INSTRUCTIONS_MAX) return fail(`The instructions are ${instructions.length} characters long; the limit is ${AGENT_INSTRUCTIONS_MAX}.`)
  // A cut must not leave a joiner or variation selector dangling at the end.
  const description = cut(described, AGENT_DESCRIPTION_MAX).replace(/[\u200d\ufe0f]+$/, '')

  return {
    ok: true,
    agent: {
      name,
      description,
      model: rawModel === '' || rawModel.toLowerCase() === 'inherit' ? null : rawModel,
      instructions,
      ignoredFields: ignored,
      descriptionCut: description.length < described.length,
      secretsMasked: masked,
    },
  }
}

/** A role suggested from a file name: `backend-engineer.md` becomes `Backend engineer`. */
export function suggestedRole(fileName: string): string {
  const words = fileName.replace(/\.md$/i, '').replace(/[-_.]+/g, ' ').trim().toLowerCase()
  const role = words === '' ? 'Agent' : words[0]!.toUpperCase() + words.slice(1)
  return cut(role, ROLE_MAX)
}
