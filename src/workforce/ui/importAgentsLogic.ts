import type { AgentFilePreview, AgentImportField, ImportAgentBody } from '../api'
import type { ImportFailure, ImportResult } from '../controller'

export const IMPORT_NEEDS_SERVER = 'Importing agents needs the server. Start the app with npm run dev:full.'
export const NO_WORKSPACE = 'No workspace is set up yet. Set WORKSPACE_ROOT and WORKSPACES in .env and restart the server.'
export const FILE_CHANGED = 'This file changed since the preview. Load it again.'

/** The one 409 that means "the file changed": the server's sentence for it. Any other refusal is shown in the server's own words. */
const SERVER_CHANGED = /changed since you looked at it/

export const importFailureMessage = (r: ImportFailure): string => (r.status === 409 && SERVER_CHANGED.test(r.error) ? FILE_CHANGED : r.error)

export const IMPORT_FIELD_LABEL: Record<AgentImportField, string> = { description: 'description', model: 'model', instructions: 'instructions' }

type Readable = Extract<AgentFilePreview, { ok: true }>

/** Sends one import; returns the text to show when it was refused, or null when it went through. An empty digest is never sent. */
export async function attemptImport(
  importAgent: ((body: ImportAgentBody) => Promise<ImportResult>) | undefined,
  workspaceId: string,
  file: Readable,
  role: string,
  department: ImportAgentBody['department'],
): Promise<string | null> {
  if (!importAgent) return IMPORT_NEEDS_SERVER
  if (file.digest === '') return 'That file could not be read. Load the list again.'
  if (role.trim() === '') return 'Enter a role.'
  const r = await importAgent({ workspaceId, file: file.file, digest: file.digest, role: role.trim(), department })
  return r.ok ? null : importFailureMessage(r)
}

export async function attemptReimport(
  reimportAgent: ((agentId: string, digest: string) => Promise<ImportResult>) | undefined,
  agentId: string,
  digest: string,
): Promise<string | null> {
  if (!reimportAgent) return IMPORT_NEEDS_SERVER
  if (digest === '') return 'That file could not be read. Load the list again.'
  const r = await reimportAgent(agentId, digest)
  return r.ok ? null : importFailureMessage(r)
}

export const reimportPrompt = (fileName: string, changes: AgentImportField[]): { title: string; message: string } => ({
  title: `Re-import ${fileName}?`,
  message: `This updates ${changes.map((c) => IMPORT_FIELD_LABEL[c]).join(', ')} from the file. The name, role, department and desk stay as they are.`,
})
