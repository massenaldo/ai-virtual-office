import { editTextFile, FILE_READ_MAX_BYTES, FileOpFailure, READ_REDACTION_LOOKAHEAD, globFiles, grepFiles, readTextFile, writeTextFile, type FileOpError } from '../fileOps'
import { truncateUtf8 } from '../limits'
import { redactSecrets } from '../redact'
import type { GatedAction, GatedOutcome, StartContext, ToolRequest } from '../runtime/types'

// One handler per model-facing tool. Every handler goes only through `ctx.tools.use`; `perform` derives the target from the
// gate's checked workspace and relative paths, never from the raw input strings. Results are fixed sentences or bounded,
// redacted file data; no host path, operating-system message or content the model sent is ever returned.

export type ToolErrorCode = FileOpError | 'denied' | 'denied_by_policy' | 'expired' | 'cancelled' | 'stale_approval' | 'revoked' | 'invalid_input' | 'not_supported'
export type ToolResult = { ok: true; text: string } | { ok: false; error: ToolErrorCode; text: string }

export const RESULT_TEXT: Record<ToolErrorCode, string> = {
  not_found: 'Not found.',
  not_a_file: 'That path is not a regular file.',
  not_a_directory: 'That path is not a directory.',
  unsafe_path: 'That path is not allowed.',
  too_large: 'The file or content is too large.',
  not_text: 'The file is not text.',
  not_unique: 'The text to replace is not unique; add context or use replace_all.',
  no_match: 'No match.',
  conflict: 'The file changed while it was being used; nothing was written.',
  aborted: 'The operation was cancelled.',
  failed: 'The operation failed.',
  denied: 'The action was not approved.',
  denied_by_policy: 'The action is not allowed by policy.',
  expired: 'The approval expired.',
  cancelled: 'The task is no longer running.',
  stale_approval: 'The action changed after it was approved; it was not run.',
  revoked: 'The permission was withdrawn or already used; it was not run.',
  invalid_input: 'The tool input is not valid.',
  not_supported: 'This tool is not available.',
}

const OUTPUT_MAX_BYTES = 65536
const READ_MARKER = '\n[truncated]'
const LIST_MARKER = '\n[results truncated]'

class NotSupported extends Error {}

const fail = (error: ToolErrorCode): ToolResult => ({ ok: false, error, text: RESULT_TEXT[error] })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const posInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)
const optionalPosInt = (v: unknown): boolean => v === undefined || posInt(v) !== undefined

type Target = { workspacePath: string; relative: string | null; signal: AbortSignal }

/** The target comes only from the gate's workspace and checked paths; a missing one fails closed. */
function target(action: GatedAction, pathRequired: boolean): Target {
  if (!action.workspace) throw new FileOpFailure('failed')
  const relative = action.paths?.[0]?.relative
  if (pathRequired && relative === undefined) throw new FileOpFailure('failed')
  return { workspacePath: action.workspace.path, relative: relative ?? null, signal: action.signal }
}

const baseOf = (t: Target) => (t.relative === null || t.relative === '' ? '.' : t.relative)

function capped(text: string, truncated: boolean): string {
  const cut = truncateUtf8(redactSecrets(text), OUTPUT_MAX_BYTES)
  return cut.truncated || truncated ? cut.text + LIST_MARKER : cut.text
}

// Accepted by the Grep policy but not implemented by vo_grep: refused up front so the result never silently differs from the request.
const UNSUPPORTED_GREP_OPTIONS = ['type', '-n', '-A', '-B', '-C', 'head_limit', 'multiline'] as const

export function createGatedTools(ctx: Pick<StartContext, 'tools'>, opts: { protectedRoots: readonly string[] }) {
  // An empty list would silently protect nothing (for example the server data folder), so a mis-wired provider fails loudly.
  if (opts.protectedRoots.length === 0) throw new Error('protectedRoots must not be empty')
  // `valid` runs before the gate, so malformed input never spends an approval or a once-grant.
  async function run(tool: string, input: unknown, valid: (input: Record<string, unknown>) => boolean, perform: (action: GatedAction, input: Record<string, unknown>) => string): Promise<ToolResult> {
    if (!isRecord(input) || !valid(input)) return fail('invalid_input')
    try {
      const outcome: GatedOutcome<string> = await ctx.tools.use({ tool, input } satisfies ToolRequest, (action) => perform(action, isRecord(action.input) ? action.input : {}))
      if (isRecord(outcome) && outcome.behavior === 'allow' && typeof outcome.value === 'string') return { ok: true, text: outcome.value }
      if (isRecord(outcome) && outcome.behavior === 'deny' && typeof outcome.outcome === 'string' && Object.hasOwn(RESULT_TEXT, outcome.outcome)) return fail(outcome.outcome)
      return fail('failed')
    } catch (error) {
      if (error instanceof NotSupported) return fail('not_supported')
      return fail(error instanceof FileOpFailure ? error.code : 'failed')
    }
  }

  return {
    vo_read: (input: unknown) =>
      run('Read', input, (i) => typeof i.file_path === 'string' && optionalPosInt(i.offset) && optionalPosInt(i.limit), (action, i) => {
        const t = target(action, true)
        // Read a little past the cap so a secret that straddles it is redacted whole, then cut after redacting.
        const read = readTextFile(t.workspacePath, t.relative!, t.signal, undefined, { maxBytes: FILE_READ_MAX_BYTES + READ_REDACTION_LOOKAHEAD })
        let text = read.text
        let sliced = false
        const offset = posInt(i.offset)
        const limit = posInt(i.limit)
        if (offset !== undefined || limit !== undefined) {
          const start = (offset ?? 1) - 1
          const lines = text.split('\n')
          const end = limit !== undefined ? start + limit : lines.length
          sliced = end < lines.length
          text = lines.slice(start, end).join('\n')
        }
        const cut = truncateUtf8(redactSecrets(text), FILE_READ_MAX_BYTES)
        return cut.truncated || (read.truncated && !sliced) ? cut.text + READ_MARKER : cut.text
      }),

    vo_glob: (input: unknown) =>
      run('Glob', input, (i) => typeof i.pattern === 'string' && (i.path === undefined || typeof i.path === 'string'), (action, i) => {
        const t = target(action, str(i.path) !== undefined)
        const found = globFiles(t.workspacePath, baseOf(t), str(i.pattern)!, t.signal, opts.protectedRoots)
        return found.paths.length === 0 ? 'No files found.' : capped(found.paths.join('\n'), found.truncated)
      }),

    vo_grep: (input: unknown) =>
      run('Grep', input, (i) => typeof i.pattern === 'string' && (i.path === undefined || typeof i.path === 'string') && UNSUPPORTED_GREP_OPTIONS.every((k) => i[k] === undefined), (action, i) => {
        const t = target(action, str(i.path) !== undefined)
        const mode = i.output_mode === 'content' ? 'content' : 'files_with_matches'
        const found = grepFiles(t.workspacePath, baseOf(t), str(i.pattern)!, { glob: str(i.glob), ignoreCase: i['-i'] === true, mode }, t.signal, opts.protectedRoots)
        if (found.matches.length === 0) return 'No matches found.'
        const lines = found.matches.map((m) => (mode === 'content' ? `${m.path}:${m.line}:${m.text}` : m.path))
        return capped(lines.join('\n'), found.truncated)
      }),

    vo_write: (input: unknown) =>
      run('Write', input, (i) => typeof i.file_path === 'string' && typeof i.content === 'string', (action, i) => {
        const t = target(action, true)
        const written = writeTextFile(t.workspacePath, t.relative!, str(i.content)!, t.signal)
        return `Wrote ${written.bytes} bytes to ${t.relative}.`
      }),

    vo_edit: (input: unknown) =>
      run('Edit', input, (i) => typeof i.file_path === 'string' && typeof i.old_string === 'string' && typeof i.new_string === 'string', (action, i) => {
        const t = target(action, true)
        editTextFile(t.workspacePath, t.relative!, str(i.old_string)!, str(i.new_string)!, i.replace_all === true, t.signal)
        return `Edited ${t.relative}.`
      }),

    // Audited through the gate, but nothing is ever run: perform refuses even when the gate approves.
    vo_run: (input: unknown) =>
      run('Bash', input, () => true, () => {
        throw new NotSupported()
      }),
  }
}
