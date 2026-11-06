import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FILE_READ_MAX_BYTES, FileOpFailure, readTextFile } from '../fileOps'
import { parseAgentFile, type ParsedAgentFile } from './parse'

export const AGENT_FILES_MAX = 50
const AGENT_FILE_NAME_MAX = 100
const AGENT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/
const validName = (n: string): boolean => n.length <= AGENT_FILE_NAME_MAX && AGENT_FILE_NAME.test(n)
const FOLDER = ['.claude', 'agents'] as const

export type AgentFile = { file: string; digest: string } & ({ ok: true; agent: ParsedAgentFile } | { ok: false; error: string })

const EMPTY_DIGEST = ''
const GONE = Symbol('gone')

/** Both folders on the way must be real directories: a link or anything else is refused and never followed. */
function folderState(workspacePath: string): 'found' | 'missing' | 'refused' {
  let cur = workspacePath
  for (const part of FOLDER) {
    cur = join(cur, part)
    let st
    try { st = lstatSync(cur) } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'refused' }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'refused'
  }
  return 'found'
}

/** GONE when the file is not there (so a caller asking for one file can answer null). Names must already be valid. */
function readOne(workspacePath: string, fileName: string, signal: AbortSignal): AgentFile | typeof GONE {
  const bad = (error: string): AgentFile => ({ file: fileName, digest: EMPTY_DIGEST, ok: false, error })
  try {
    const { text, truncated } = readTextFile(workspacePath, `${FOLDER.join('/')}/${fileName}`, signal, undefined, { maxBytes: FILE_READ_MAX_BYTES })
    if (truncated) return bad(`The file is larger than ${FILE_READ_MAX_BYTES} bytes.`)
    // Strictly decoded and untruncated text re-encodes to the exact bytes read.
    const digest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    const parsed = parseAgentFile(text)
    return parsed.ok ? { file: fileName, digest, ok: true, agent: parsed.agent } : { file: fileName, digest, ok: false, error: parsed.error }
  } catch (error) {
    if (error instanceof FileOpFailure) {
      if (error.code === 'aborted') throw error
      if (error.code === 'not_found') return GONE
      if (error.code === 'not_text') return bad('The file is not valid UTF-8 text.')
      if (error.code === 'unsafe_path') return bad('The file is a link, or has more than one hard link, and was not read.')
      if (error.code === 'not_a_file') return bad('This is not a regular file and was not read.')
    }
    return bad('The file could not be read.')
  }
}

/** Every plain agent file name in the folder, as the disk lists them (not cut to the preview limit); null when the folder is missing. */
export function listAgentFileNames(workspacePath: string): string[] | null {
  if (folderState(workspacePath) !== 'found') return null
  try {
    return readdirSync(join(workspacePath, ...FOLDER), { withFileTypes: true }).filter((d) => !d.isDirectory()).map((d) => d.name).filter(validName).sort()
  } catch {
    return null
  }
}

export function readAgentFiles(workspacePath: string, signal: AbortSignal): { folder: 'found' | 'missing' | 'refused'; files: AgentFile[]; cut: boolean } {
  const state = folderState(workspacePath)
  if (state !== 'found') return { folder: state, files: [], cut: false }
  let names: string[]
  try {
    names = readdirSync(join(workspacePath, ...FOLDER), { withFileTypes: true })
      .filter((d) => !d.isDirectory() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => d.name)
      .sort()
  } catch {
    return { folder: 'missing', files: [], cut: false }
  }
  const cut = names.length > AGENT_FILES_MAX
  const files = names.slice(0, AGENT_FILES_MAX).map((n, i): AgentFile => {
    // A refused name is never echoed: it could carry control characters, bidi marks or a secret.
    if (!validName(n)) return { file: `(file ${i + 1})`, digest: EMPTY_DIGEST, ok: false, error: `This file name is not allowed: use up to ${AGENT_FILE_NAME_MAX} letters, digits, dots, dashes and underscores, ending in .md.` }
    const r = readOne(workspacePath, n, signal)
    return r === GONE ? { file: n, digest: EMPTY_DIGEST, ok: false, error: 'The file could not be read.' } : r
  })
  return { folder: 'found', files, cut }
}

/** One file by name; null when the name is not a plain agent file name or the file is not there. */
export function readAgentFile(workspacePath: string, fileName: string, signal: AbortSignal): AgentFile | null {
  if (!validName(fileName) || folderState(workspacePath) !== 'found') return null
  const r = readOne(workspacePath, fileName, signal)
  return r === GONE ? null : r
}
