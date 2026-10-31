import type { AgentResponse, ApprovalBody, CreateAgentBody, CreateTaskBody, DeskBody, PatchAgentBody } from '../api'
import type { ActionResult, WorkforceController } from '../controller'
import type { Agent } from '../types'
import type { ApiClient, ApiResult, MutationMethod } from './client'

export type RemoteCommands = Pick<WorkforceController, 'createAgent' | 'updateAgent' | 'removeAgent' | 'assignDesk' | 'startTask' | 'cancelTask' | 'decideApproval' | 'requestApproval' | 'forceError' | 'restoreDemoAgents'>

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

  return {
    async createAgent(input) {
      const r = await client.send<AgentResponse>('POST', '/api/agents', input satisfies CreateAgentBody)
      if (!r.ok) return { ok: false, error: r.error }
      insertAgent(r.body.agent)
      reportError(null)
      return { ok: true, id: r.body.agent.id }
    },
    updateAgent: (agentId, patch) => result('PATCH', `/api/agents/${id(agentId)}`, patch satisfies PatchAgentBody),
    removeAgent: (agentId) => fireAndForget('DELETE', `/api/agents/${id(agentId)}`),
    assignDesk: (agentId, deskId) => result('PUT', `/api/agents/${id(agentId)}/desk`, { deskId } satisfies DeskBody),
    startTask: (agentId, input) => result('POST', `/api/agents/${id(agentId)}/tasks`, { title: input.title, description: input.description } satisfies CreateTaskBody),
    cancelTask: (taskId) => result('POST', `/api/tasks/${id(taskId)}/cancel`),
    decideApproval: (taskId, approvalId, decision) => result('POST', `/api/tasks/${id(taskId)}/approval`, { approvalId, decision } satisfies ApprovalBody),
    requestApproval: (taskId) => fireAndForget('POST', `/api/demo/tasks/${id(taskId)}/request-approval`),
    forceError: (taskId) => fireAndForget('POST', `/api/demo/tasks/${id(taskId)}/force-error`),
    restoreDemoAgents: () => fireAndForget('POST', '/api/demo/agents/restore'),
  }
}
