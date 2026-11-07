import type { AgentInput, TaskInput } from '../../src/workforce/operations'
import type { ApprovalChoice } from '../taskManager'
import { HttpError, type RejectCode } from './router'

// Strict parsing of what the browser sends. Unknown keys are rejected, so a path, working directory or command can
// never ride along; business rules (name length, desk taken, one task per agent) stay with the operations and answer 422/409.

type Body = Record<string, unknown>

const bad = (message: string, code?: RejectCode) => new HttpError(400, message, code)

function allow(b: Body, keys: string[]): void {
  for (const key of Object.keys(b)) if (!keys.includes(key)) throw bad(`Unknown field "${key}".`, 'unknown_field')
}

function text(b: Body, key: string): string {
  const v = b[key]
  if (typeof v !== 'string') throw bad(`"${key}" must be a string.`)
  return v
}

/** The editable agent fields. `sourceFile` is deliberately absent: only an import sets it. */
const AGENT_FIELDS = ['name', 'role', 'department', 'description', 'instructions', 'model', 'takesPrayerBreaks']

function profile(b: Body): Partial<AgentInput> {
  const out: Partial<AgentInput> = {}
  if ('description' in b) out.description = text(b, 'description')
  if ('instructions' in b) out.instructions = text(b, 'instructions')
  if ('model' in b) {
    if (b.model !== null && typeof b.model !== 'string') throw bad('"model" must be a string or null.')
    out.model = b.model
  }
  if ('takesPrayerBreaks' in b) {
    if (typeof b.takesPrayerBreaks !== 'boolean') throw bad('"takesPrayerBreaks" must be a boolean.')
    out.takesPrayerBreaks = b.takesPrayerBreaks
  }
  return out
}

export function parseCreateAgent(b: Body): AgentInput {
  allow(b, AGENT_FIELDS)
  return { name: text(b, 'name'), role: text(b, 'role'), department: text(b, 'department') as AgentInput['department'], ...profile(b) }
}

export function parsePatchAgent(b: Body): Partial<AgentInput> {
  allow(b, AGENT_FIELDS)
  const patch: Partial<AgentInput> = {}
  if ('name' in b) patch.name = text(b, 'name')
  if ('role' in b) patch.role = text(b, 'role')
  if ('department' in b) patch.department = text(b, 'department') as AgentInput['department']
  Object.assign(patch, profile(b))
  if (Object.keys(patch).length === 0) throw bad('Send at least one of "name", "role", "department", "description", "instructions", "model" or "takesPrayerBreaks".')
  return patch
}

export type ImportAgentRequest = { workspaceId: string; file: string; digest: string; role: string; department: AgentInput['department'] }

const DIGEST_RE = /^[0-9a-f]{64}$/
function digestOf(b: Body): string {
  const d = text(b, 'digest')
  if (!DIGEST_RE.test(d)) throw bad('"digest" must be 64 lowercase hex characters.')
  return d
}

/** A closed list: the name, instructions, model and source of an imported agent come from the file, never from the request. */
export function parseImportAgent(b: Body): ImportAgentRequest {
  allow(b, ['workspaceId', 'file', 'digest', 'role', 'department'])
  return { workspaceId: text(b, 'workspaceId'), file: text(b, 'file'), digest: digestOf(b), role: text(b, 'role'), department: text(b, 'department') as AgentInput['department'] }
}

export function parseReimportAgent(b: Body): { digest: string } {
  allow(b, ['digest'])
  return { digest: digestOf(b) }
}

export function parseDesk(b: Body): { deskId: string | null } {
  allow(b, ['deskId'])
  const v = b.deskId
  if (v === null) return { deskId: null }
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) throw bad('"deskId" must be a desk id or null.')
  return { deskId: v }
}

export type CreateTaskRequest = TaskInput & { workspaceId: string | null; /** Absent means the server's default runtime. */ runtime?: 'mock' | 'claude' }

export function parseCreateTask(b: Body): CreateTaskRequest {
  allow(b, ['title', 'description', 'workspaceId', 'runtime'])
  const description = 'description' in b ? text(b, 'description') : ''
  const workspaceId = b.workspaceId === undefined ? null : b.workspaceId
  if (workspaceId !== null && typeof workspaceId !== 'string') throw bad('"workspaceId" must be a string or null.')
  if (b.runtime !== undefined && b.runtime !== 'mock' && b.runtime !== 'claude') throw bad('"runtime" must be "mock" or "claude".')
  return { title: text(b, 'title'), description, workspaceId, ...(b.runtime === undefined ? {} : { runtime: b.runtime }) }
}

const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['allow_once', 'allow_task', 'allow_agent', 'reject', 'approve', 'deny']

export function parseApproval(b: Body): { approvalId: string; decision: ApprovalChoice; digest: string | undefined } {
  allow(b, ['approvalId', 'decision', 'digest'])
  if (typeof b.approvalId !== 'string' || b.approvalId === '') throw bad('"approvalId" must be a non-empty string.')
  if (!APPROVAL_CHOICES.includes(b.decision as ApprovalChoice)) throw bad('"decision" must be "allow_once", "allow_task", "allow_agent", "reject", "approve" or "deny".')
  if (b.digest !== undefined && !(typeof b.digest === 'string' && /^[0-9a-f]{64}$/.test(b.digest))) throw bad('"digest" must be 64 lowercase hex characters.')
  return { approvalId: b.approvalId, decision: b.decision as ApprovalChoice, digest: b.digest }
}

export type CreatePermissionRequest = { scope: 'global' | 'agent'; effect: 'allow' | 'deny' | 'ask'; tool: string; agentId: string | null; pathPattern: string | null; workspaceId: string | null; expiresAt: string | null; reason: string | null }

const optionalText = (b: Body, key: string): string | null => {
  const v = b[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw bad(`"${key}" must be a string or null.`)
  return v
}

/** Task and once permissions come from approvals, so only global and agent rules can be created here. */
export function parseCreatePermission(b: Body): CreatePermissionRequest {
  allow(b, ['scope', 'effect', 'tool', 'agentId', 'pathPattern', 'workspaceId', 'expiresAt', 'reason'])
  if (b.scope !== 'global' && b.scope !== 'agent') throw bad('"scope" must be "global" or "agent".')
  return { scope: b.scope, effect: text(b, 'effect') as CreatePermissionRequest['effect'], tool: text(b, 'tool'), agentId: optionalText(b, 'agentId'), pathPattern: optionalText(b, 'pathPattern'), workspaceId: optionalText(b, 'workspaceId'), expiresAt: optionalText(b, 'expiresAt'), reason: optionalText(b, 'reason') }
}

/** The layout is checked by parseLayout; this only closes the list of fields. */
export function parsePutLayout(b: Body): unknown {
  allow(b, ['layout'])
  return b.layout
}
