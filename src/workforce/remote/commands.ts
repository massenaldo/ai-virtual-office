import type { AgentFilesResponse, AgentResponse, ApprovalBody, ImportAgentBody, ReimportAgentBody, CreatePermissionBody, CreateAgentBody, CreateTaskBody, DeskBody, PatchAgentBody } from '../api'
import type { ActionResult, ImportResult, ListFilesResult, WorkforceController } from '../controller'
import type { Agent } from '../types'
import type { ApiClient, ApiResult, MutationMethod } from './client'

export type RemoteCommands = Pick<WorkforceController, 'createAgent' | 'updateAgent' | 'removeAgent' | 'clearAgentError' | 'assignDesk' | 'startTask' | 'cancelTask' | 'startHeldTask' | 'decideApproval' | 'requestApproval' | 'forceError' | 'restoreDemoAgents'> & PermissionCommands & ImportCommands

/** Backend only: the local mock has no permission engine. A refusal comes back to the caller as the server's own text. */
export type PermissionCommands = {
  createPermission(body: CreatePermissionBody): Promise<ActionResult>
  revokePermission(permissionId: string): Promise<ActionResult>
  revokeAgentPermissions(agentId: string): Promise<ActionResult>
}

/** Backend only: the local mock reads no files. A refusal comes back with its status and the server's own text. */
export type ImportCommands = {
  listAgentFiles(workspaceId: string): Promise<ListFilesResult>
  importAgent(body: ImportAgentBody): Promise<ImportResult>
  reimportAgent(agentId: string, digest: string): Promise<ImportResult>
}

const id = encodeURIComponent

/**
 * One REST call per action. Actions that return a result hand a failure to the form that asked; the four that return
 * nothing report it through reportError. Except for createAgent, response bodies are ignored: changes arrive as events.
 */
export function createRemoteCommands(deps: { client: ApiClient; insertAgent(agent: Agent): void; reportError(message: string | null): void }): RemoteCommands {
  const { client, insertAgent, reportError } = deps

  const result = async (method: MutationMethod, path: string, body?: unknown): Promise<ActionResult> => {
    const r = await client.send(method, path, body)
    if (!r.ok) return { ok: false, error: r.error }
    reportError(null)
    return { ok: true }
  }
  const fireAndForget = (method: MutationMethod, path: string): void => {
    void client.send(method, path).then((r: ApiResult<unknown>) => reportError(r.ok ? null : r.error))
  }

  const importCall = async (path: string, body: unknown): Promise<ImportResult> => {
    const r = await client.send<AgentResponse>('POST', path, body)
    if (!r.ok) return { ok: false, error: r.error, status: r.status }
    insertAgent(r.body.agent)
    reportError(null)
    return { ok: true, agentId: r.body.agent.id }
  }

  return {
    async listAgentFiles(workspaceId) {
      const r = await client.get<AgentFilesResponse>(`/api/workspaces/${id(workspaceId)}/agent-files`)
      return r.ok ? { ok: true, response: r.body } : { ok: false, error: r.error, status: r.status }
    },
    importAgent: (body) => importCall('/api/agents/import', body satisfies ImportAgentBody),
    reimportAgent: (agentId, digest) => importCall(`/api/agents/${id(agentId)}/reimport`, { digest } satisfies ReimportAgentBody),
    async createAgent(input) {
      const r = await client.send<AgentResponse>('POST', '/api/agents', input satisfies CreateAgentBody)
      if (!r.ok) return { ok: false, error: r.error }
      insertAgent(r.body.agent)
      reportError(null)
      return { ok: true, id: r.body.agent.id }
    },
    updateAgent: (agentId, patch) => result('PATCH', `/api/agents/${id(agentId)}`, patch satisfies PatchAgentBody),
    removeAgent: (agentId) => fireAndForget('DELETE', `/api/agents/${id(agentId)}`),
    clearAgentError: (agentId) => result('POST', `/api/agents/${id(agentId)}/clear-error`),
    assignDesk: (agentId, deskId) => result('PUT', `/api/agents/${id(agentId)}/desk`, { deskId } satisfies DeskBody),
    startTask: (agentId, input, opts) => result('POST', `/api/agents/${id(agentId)}/tasks`, { title: input.title, description: input.description, ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}), ...(opts?.runtime ? { runtime: opts.runtime } : {}) } satisfies CreateTaskBody),
    cancelTask: (taskId) => result('POST', `/api/tasks/${id(taskId)}/cancel`),
    startHeldTask: (taskId) => result('POST', `/api/tasks/${id(taskId)}/start-now`),
    decideApproval: (taskId, approvalId, decision, digest) => result('POST', `/api/tasks/${id(taskId)}/approval`, { approvalId, decision, ...(typeof digest === 'string' ? { digest } : {}) } satisfies ApprovalBody),
    createPermission: (body) => result('POST', '/api/permissions', body satisfies CreatePermissionBody),
    revokePermission: (permissionId) => result('DELETE', `/api/permissions/${id(permissionId)}`),
    revokeAgentPermissions: (agentId) => result('DELETE', `/api/agents/${id(agentId)}/permissions`),
    requestApproval: (taskId) => fireAndForget('POST', `/api/demo/tasks/${id(taskId)}/request-approval`),
    forceError: (taskId) => fireAndForget('POST', `/api/demo/tasks/${id(taskId)}/force-error`),
    restoreDemoAgents: () => fireAndForget('POST', '/api/demo/agents/restore'),
  }
}
