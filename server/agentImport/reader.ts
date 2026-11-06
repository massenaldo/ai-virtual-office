import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FILE_READ_MAX_BYTES, FileOpFailure, readTextFile } from '../fileOps'
import { parseAgentFile, type ParsedAgentFile } from './parse'

export const AGENT_FILES_MAX = 50
const AGENT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/
const FOLDER = ['.claude', 'agents'] as const

export type AgentFile = { file: string; digest: string } & ({ ok: true; agent: ParsedAgentFile } | { ok: false; error: string })

const EMPTY_DIGEST = ''

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

function readOne(workspacePath: string, fileName: string, signal: AbortSignal): AgentFile {
  const bad = (error: string): AgentFile => ({ file: fileName, digest: EMPTY_DIGEST, ok: false, error })
  if (!AGENT_FILE_NAME.test(fileName)) return bad('This file name is not allowed: use letters, digits, dots, dashes and underscores, ending in .md.')
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
      if (error.code === 'not_text') return bad('The file is not valid UTF-8 text.')
      if (error.code === 'unsafe_path') return bad('The file is a link, or has more than one hard link, and was not read.')
    }
    return bad('The file could not be read.')
  }
}

export function readAgentFiles(workspacePath: string, signal: AbortSignal): { folder: 'found' | 'missing'; files: AgentFile[]; cut: boolean } {
  const state = folderState(workspacePath)
  if (state !== 'found') return { folder: 'missing', files: [], cut: false }
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
  return { folder: 'found', files: names.slice(0, AGENT_FILES_MAX).map((n) => readOne(workspacePath, n, signal)), cut }
}

/** One file by name; null when the name is not a plain agent file name or the file is not there. */
export function readAgentFile(workspacePath: string, fileName: string, signal: AbortSignal): AgentFile | null {
  if (!AGENT_FILE_NAME.test(fileName) || folderState(workspacePath) !== 'found') return null
  const file = readOne(workspacePath, fileName, signal)
  if (!file.ok && file.error === 'The file could not be read.') {
    try { lstatSync(join(workspacePath, ...FOLDER, fileName)) } catch { return null }
  }
  return file
}
