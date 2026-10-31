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

export function parseCreateAgent(b: Body): AgentInput {
  allow(b, ['name', 'role', 'department'])
  return { name: text(b, 'name'), role: text(b, 'role'), department: text(b, 'department') as AgentInput['department'] }
}

export function parsePatchAgent(b: Body): Partial<AgentInput> {
  allow(b, ['name', 'role', 'department'])
  const patch: Partial<AgentInput> = {}
  if ('name' in b) patch.name = text(b, 'name')
  if ('role' in b) patch.role = text(b, 'role')
  if ('department' in b) patch.department = text(b, 'department') as AgentInput['department']
  if (Object.keys(patch).length === 0) throw bad('Send at least one of "name", "role" or "department".')
  return patch
}

export function parseDesk(b: Body): { deskId: string | null } {
  allow(b, ['deskId'])
  const v = b.deskId
  if (v === null) return { deskId: null }
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) throw bad('"deskId" must be a desk id or null.')
  return { deskId: v }
}

export type CreateTaskRequest = TaskInput & { workspaceId: string | null }

export function parseCreateTask(b: Body): CreateTaskRequest {
  allow(b, ['title', 'description', 'workspaceId'])
  const description = 'description' in b ? text(b, 'description') : ''
  const workspaceId = b.workspaceId === undefined ? null : b.workspaceId
  if (workspaceId !== null && typeof workspaceId !== 'string') throw bad('"workspaceId" must be a string or null.')
  return { title: text(b, 'title'), description, workspaceId }
}

const APPROVAL_CHOICES: readonly ApprovalChoice[] = ['allow_once', 'allow_task', 'allow_agent', 'reject', 'approve', 'deny']

export function parseApproval(b: Body): { approvalId: string; decision: ApprovalChoice; digest: string | undefined } {
  allow(b, ['approvalId', 'decision', 'digest'])
  if (typeof b.approvalId !== 'string' || b.approvalId === '') throw bad('"approvalId" must be a non-empty string.')
  if (!APPROVAL_CHOICES.includes(b.decision as ApprovalChoice)) throw bad('"decision" must be "allow_once", "allow_task", "allow_agent", "reject", "approve" or "deny".')
  if (b.digest !== undefined && !(typeof b.digest === 'string' && /^[0-9a-f]{64}$/.test(b.digest))) throw bad('"digest" must be 64 lowercase hex characters.')
  return { approvalId: b.approvalId, decision: b.decision as ApprovalChoice, digest: b.digest }
}

export type CreatePermissionRequest = { scope: 'global' | 'agent'; effect: 'allow' | 'deny' | 'ask'; tool: string; agentId: string | null; pathPattern: string | null; expiresAt: string | null; reason: string | null }

const optionalText = (b: Body, key: string): string | null => {
  const v = b[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw bad(`"${key}" must be a string or null.`)
  return v
}

/** Task and once permissions come from approvals, so only global and agent rules can be created here. */
export function parseCreatePermission(b: Body): CreatePermissionRequest {
  allow(b, ['scope', 'effect', 'tool', 'agentId', 'pathPattern', 'expiresAt', 'reason'])
  if (b.scope !== 'global' && b.scope !== 'agent') throw bad('"scope" must be "global" or "agent".')
  return { scope: b.scope, effect: text(b, 'effect') as CreatePermissionRequest['effect'], tool: text(b, 'tool'), agentId: optionalText(b, 'agentId'), pathPattern: optionalText(b, 'pathPattern'), expiresAt: optionalText(b, 'expiresAt'), reason: optionalText(b, 'reason') }
}
