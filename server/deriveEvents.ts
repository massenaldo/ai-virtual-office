import type { ChangeEvent, WorkforceEventType } from '../src/workforce/api'
import type { ActivityType, Agent, AgentTask, WorkforceState } from '../src/workforce/types'

export type EventDraft = Omit<ChangeEvent, 'id' | 'at'>

const EVENT_FOR_ACTIVITY: Record<ActivityType, Exclude<WorkforceEventType, 'state.reset'>> = {
  'task-assigned': 'task.queued',
  'task-started': 'task.started',
  'task-progress': 'task.progress',
  'agent-message': 'agent.message',
  'task-approval-requested': 'task.waiting_for_approval',
  'task-completed': 'task.completed',
  'task-failed': 'task.failed',
  'task-timed-out': 'task.failed',
  'task-cancelled': 'task.cancelled',
  'agent-created': 'state.changed',
  'agent-updated': 'state.changed',
  'desk-assigned': 'state.changed',
  'desk-unassigned': 'state.changed',
  'task-approval-decided': 'state.changed',
  'task-cancelling': 'state.changed',
}

/**
 * Typed events for one commit, worked out by comparing the two states, so no code path can forget an event or send one
 * that disagrees with what was saved. Every record an event carries has its final value, so applying the events in
 * order to `before` always gives `after`.
 */
export function deriveEvents(before: WorkforceState, after: WorkforceState): EventDraft[] {
  if (before === after) return []
  const drafts: EventDraft[] = []
  const carriedAgents = new Set<string>()
  const carriedTasks = new Set<string>()
  const emit = (draft: EventDraft) => {
    drafts.push(draft)
    draft.patch.agents.forEach((a) => carriedAgents.add(a.id))
    draft.patch.tasks.forEach((t) => carriedTasks.add(t.id))
  }

  const beforeAgents = new Map(before.agents.map((a) => [a.id, a]))
  const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]))
  const afterAgents = new Map(after.agents.map((a) => [a.id, a]))
  const afterTasks = new Map(after.tasks.map((t) => [t.id, t]))

  // 1. Removed agents (their tasks and activities go with them).
  const removed = before.agents.filter((a) => !afterAgents.has(a.id)).map((a) => a.id)
  if (removed.length > 0) emit({ type: 'state.changed', agentId: removed.length === 1 ? removed[0] : null, taskId: null, patch: { agents: [], tasks: [], activities: [], removedAgentIds: removed } })

  // 2. New activities, each with its agent and task as they are now.
  const known = new Set(before.activities.map((a) => a.id))
  for (const activity of after.activities) {
    if (known.has(activity.id)) continue
    const agent = afterAgents.get(activity.agentId)
    const task = activity.taskId === null ? undefined : afterTasks.get(activity.taskId)
    emit({ type: EVENT_FOR_ACTIVITY[activity.type], agentId: activity.agentId, taskId: activity.taskId, patch: { agents: agent ? [agent] : [], tasks: task ? [task] : [], activities: [activity], removedAgentIds: [] } })
  }

  // 3. Status changes.
  for (const agent of after.agents) {
    const prev = beforeAgents.get(agent.id)
    if (prev && prev.status !== agent.status) emit({ type: 'agent.status_changed', agentId: agent.id, taskId: agent.currentTaskId, from: prev.status, to: agent.status, patch: { agents: [agent], tasks: [], activities: [], removedAgentIds: [] } })
  }

  // 4. Anything else that changed without an activity (for example a task moving to starting).
  const agents: Agent[] = after.agents.filter((a) => !carriedAgents.has(a.id) && beforeAgents.get(a.id) !== a)
  const tasks: AgentTask[] = after.tasks.filter((t) => !carriedTasks.has(t.id) && beforeTasks.get(t.id) !== t)
  if (agents.length > 0 || tasks.length > 0) emit({ type: 'state.changed', agentId: null, taskId: null, patch: { agents, tasks, activities: [], removedAgentIds: [] } })

  return drafts
}
