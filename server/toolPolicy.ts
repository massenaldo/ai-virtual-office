import type { ServerConfig } from './config'
import { REVIEW_MAX_BYTES, type ToolReviewBody } from '../src/workforce/types'
import { formatBytes } from './limits'
import { redactSecrets, scrub } from './redact'
import { checkPathInWorkspace, type ResolvedWorkspace } from './workspaces'

// What an agent may do. decideToolUse is pure apart from read-only filesystem checks. There is deliberately no bypass:
// a tool that writes, runs commands or uses the network can only ever be `ask` (a human decides), never `allow`.

export type ToolCategory = 'read' | 'write' | 'execute' | 'network'

export type ToolSpec = { name: string; category: ToolCategory; description: string; pathArgs: readonly string[]; pathRequired: boolean; needsWorkspace: boolean }

/** Names match Claude Code's tool names so a future provider maps them one to one; any other name is unknown. */
export const TOOL_CATALOGUE: readonly ToolSpec[] = [
  { name: 'Read', category: 'read', description: 'Read a file inside the workspace', pathArgs: ['file_path'], pathRequired: true, needsWorkspace: true },
  { name: 'Glob', category: 'read', description: 'Find files by name pattern inside the workspace', pathArgs: ['path'], pathRequired: false, needsWorkspace: true },
  { name: 'Grep', category: 'read', description: 'Search file contents inside the workspace', pathArgs: ['path'], pathRequired: false, needsWorkspace: true },
  { name: 'Write', category: 'write', description: 'Create or overwrite a file inside the workspace', pathArgs: ['file_path'], pathRequired: true, needsWorkspace: true },
  { name: 'Edit', category: 'write', description: 'Change part of a file inside the workspace', pathArgs: ['file_path'], pathRequired: true, needsWorkspace: true },
  { name: 'Bash', category: 'execute', description: 'Run a shell command in the workspace', pathArgs: [], pathRequired: false, needsWorkspace: true },
  { name: 'WebFetch', category: 'network', description: 'Fetch a web page', pathArgs: [], pathRequired: false, needsWorkspace: false },
  { name: 'WebSearch', category: 'network', description: 'Search the web', pathArgs: [], pathRequired: false, needsWorkspace: false },
]

export const DEFAULT_ALLOWED_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Write', 'Edit']
export const SUMMARY_MAX_CHARS = 200
const BASH_MAX_CHARS = 10000
const PATTERN_MAX_CHARS = 1000
const URL_MAX_CHARS = 2000

/** The input fields each tool defines (Claude Code's names). Any other field is refused, so nothing unreviewed rides along. */
const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  Read: ['file_path', 'offset', 'limit'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-A', '-B', '-C', 'head_limit', 'multiline'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Bash: ['command', 'description', 'timeout'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
}

export type ToolPolicy = { readonly allowedTools: ReadonlySet<string> }

export type DenyReason = 'unknown_tool' | 'not_allowed' | 'invalid_input' | 'invalid_path' | 'missing_path' | 'outside_workspace' | 'unsafe_symlink' | 'no_workspace' | 'approval_pending' | 'not_reviewable' | 'unsafe_link'

/** A path argument that passed the workspace check: the argument name and the path relative to the workspace. */
export type CheckedPath = { readonly arg: string; readonly relative: string }

export type ToolDecision =
  | { decision: 'allow'; reason: 'read_only'; summary: string; paths?: CheckedPath[] }
  | { decision: 'ask'; reason: 'needs_approval'; summary: string; paths?: CheckedPath[]; /** Write and Edit only: the exact content or change to review. */ review?: ToolReviewBody }
  | { decision: 'deny'; reason: DenyReason; summary: string }

const DENY_TEXT: Record<DenyReason, string> = {
  unknown_tool: 'unknown tool',
  not_allowed: 'not in ALLOWED_TOOLS',
  invalid_input: 'invalid input',
  invalid_path: 'invalid path',
  missing_path: 'a path is required',
  outside_workspace: 'path is outside the task workspace',
  unsafe_symlink: 'path goes through a broken symlink',
  no_workspace: 'the task has no workspace',
  approval_pending: 'another tool approval is already pending for this task',
  not_reviewable: 'the request cannot be shown to a reviewer in full',
  unsafe_link: 'the file has more than one name (a hard link)',
}

export function toolPolicyFrom(config: Pick<ServerConfig, 'allowedTools'>): ToolPolicy {
  return { allowedTools: new Set(config.allowedTools) }
}

/** Redacts secrets, flattens control characters and spaces, and caps the length: safe to show a human and to store. */
export function sanitizeSummary(text: string): string {
  const flat = redactSecrets(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.length <= SUMMARY_MAX_CHARS ? flat : `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

export function toolDeniedMessage(tool: string, reason: DenyReason): string {
  return `Tool "${scrub(tool, 64)}" denied by policy: ${DENY_TEXT[reason]}.`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The required non-path fields per tool; false means invalid input. */
function fieldsValid(tool: string, i: Record<string, unknown>): boolean {
  switch (tool) {
    case 'Glob': return nonEmpty(i.pattern) && i.pattern.length <= PATTERN_MAX_CHARS
    case 'Grep': return nonEmpty(i.pattern) && i.pattern.length <= PATTERN_MAX_CHARS && (i.glob === undefined || (nonEmpty(i.glob) && i.glob.length <= PATTERN_MAX_CHARS))
    case 'Write': return typeof i.content === 'string'
    case 'Edit': return typeof i.old_string === 'string' && typeof i.new_string === 'string'
    case 'Bash': return nonEmpty(i.command) && i.command.length <= BASH_MAX_CHARS
    case 'WebFetch': {
      if (!nonEmpty(i.url) || i.url.length > URL_MAX_CHARS) return false
      try {
        const u = new URL(i.url)
        return ['http:', 'https:'].includes(u.protocol) && u.username === '' && u.password === ''
      } catch { return false }
    }
    case 'WebSearch': return nonEmpty(i.query) && i.query.length <= PATTERN_MAX_CHARS
    default: return true
  }
}

/** A glob is matched inside the workspace: no absolute, home-relative or climbing pattern. */
function globInside(pattern: string): boolean {
  // Any `..` at all, not only as a whole segment: a glob engine expands `{..,x}` or `@(..)` into a parent directory.
  return !pattern.startsWith('/') && !pattern.startsWith('~') && !pattern.includes('\\') && !pattern.includes('..')
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
const byteLength = (text: string): number => Buffer.byteLength(text)

/**
 * Characters that make what a person reads differ from what is run or written, or that cannot be seen at all: C1 controls,
 * every format character (bidi overrides and isolates, zero-width and joiner characters, the byte order mark, soft hyphen,
 * tag characters), line and paragraph separators (U+2028 and U+2029 end a line in JavaScript), private use, lone
 * surrogates, variation selectors and the Hangul fillers. (A joiner also splits an emoji sequence, so those are refused too.)
 */
const INVISIBLE = /[\u0080-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u115f\u1160\u3164\uffa0]/u
/** Content may keep tab, newline and carriage return; every other control character and everything in INVISIBLE is refused. */
const UNSAFE_TO_SHOW = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]|${INVISIBLE.source}`, 'u')

/**
 * The exact content or change of a Write or Edit, for a person to read. Null when it cannot be shown safely and whole:
 * too big, characters that would make what is shown differ from what is written, a secret that redaction would change,
 * or the workspace's own path (it must never reach state).
 */
function buildReview(tool: string, i: Record<string, unknown>, rel: string, workspacePath: string): ToolReviewBody | null {
  const texts = tool === 'Write' ? [i.content as string] : [i.old_string as string, i.new_string as string]
  const total = [rel, ...texts].reduce((n, t) => n + byteLength(t), 0)
  if (total > REVIEW_MAX_BYTES) return null
  if (texts.some((t) => UNSAFE_TO_SHOW.test(t) || redactSecrets(t) !== t || t.includes(workspacePath))) return null
  if (tool === 'Write') return { kind: 'write', path: rel, bytes: byteLength(texts[0]), lines: lineCount(texts[0]), content: texts[0] }
  return { kind: 'edit', path: rel, bytes: byteLength(texts[0]) + byteLength(texts[1]), lines: lineCount(texts[0]) + lineCount(texts[1]), oldString: texts[0], newString: texts[1], replaceAll: i.replace_all === true }
}

function summaryFor(tool: string, i: Record<string, unknown>, rel: string | null): string {
  switch (tool) {
    case 'Read': return `Read ${rel}`
    case 'Glob': return `Find files matching ${i.pattern} in ${rel ?? '.'}`
    case 'Grep': return `Search for ${i.pattern} in ${rel ?? '.'}`
    // Write and Edit show a short line here; the full content or change is the review (see buildReview).
    case 'Write': return `Write ${rel} (${formatBytes(Buffer.byteLength(i.content as string))}, ${lineCount(i.content as string)} ${lineCount(i.content as string) === 1 ? 'line' : 'lines'}): review the full content`
    case 'Edit': return `Edit ${rel}: review the full change`
    case 'Bash': return `Run command: ${i.command}`
    case 'WebFetch': { const u = new URL(i.url as string); return `Fetch ${u.origin}${u.pathname}${u.search}` }
    default: return `Search the web for ${i.query}`
  }
}

/** The first matching rule wins. It never echoes input in a denial and never returns an absolute path. */
export function decideToolUse(policy: ToolPolicy, toolName: string, input: unknown, workspace: ResolvedWorkspace | null): ToolDecision {
  const spec = TOOL_CATALOGUE.find((t) => t.name === toolName)
  const denied = (reason: DenyReason): ToolDecision => ({ decision: 'deny', reason, summary: `Tool "${scrub(toolName, 64)}"` })
  if (!spec) return denied('unknown_tool')
  if (!policy.allowedTools.has(spec.name)) return denied('not_allowed')
  if (!isRecord(input)) return denied('invalid_input')
  if (Object.keys(input).some((k) => !ALLOWED_FIELDS[spec.name]?.includes(k))) return denied('invalid_input')
  if (!fieldsValid(spec.name, input)) return denied('invalid_input')
  const globs = [spec.name === 'Glob' || spec.name === 'Grep' ? input.glob : undefined, spec.name === 'Glob' ? input.pattern : undefined]
  if (globs.some((g) => typeof g === 'string' && !globInside(g))) return denied('outside_workspace')
  if (spec.pathRequired && spec.pathArgs.every((a) => input[a] === undefined)) return denied('missing_path')
  if (spec.needsWorkspace && workspace === null) return denied('no_workspace')

  let rel: string | null = null
  const paths: CheckedPath[] = []
  for (const arg of spec.pathArgs) {
    if (input[arg] === undefined) continue
    const checked = checkPathInWorkspace(workspace!.path, input[arg])
    if (!checked.ok) return denied(checked.reason)
    rel = checked.relative
    paths.push({ arg, relative: checked.relative })
  }
  const withPaths = paths.length > 0 ? { paths } : {}

  const raw = summaryFor(spec.name, input, rel)
  if (spec.category === 'read') return { decision: 'allow', reason: 'read_only', summary: sanitizeSummary(raw), ...withPaths }
  // What a person approves must read the way it runs: invisible and reordering characters are refused in every ask summary.
  if (INVISIBLE.test(raw)) return denied('not_reviewable')
  // A human approves what the summary says, so it must be the whole action: if redaction or the length cap would change
  // it, nothing is asked. (Only control characters and repeated spaces are flattened.)
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/ {2,}/g, ' ').trim()
  if (flat.length > SUMMARY_MAX_CHARS || redactSecrets(flat) !== flat) return denied('not_reviewable')
  if (spec.name === 'Write' || spec.name === 'Edit') {
    const review = buildReview(spec.name, input, rel!, workspace!.path)
    return review ? { decision: 'ask', reason: 'needs_approval', summary: flat, review, ...withPaths } : denied('not_reviewable')
  }
  return { decision: 'ask', reason: 'needs_approval', summary: flat, ...withPaths }
}
