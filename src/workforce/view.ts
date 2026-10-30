import { DEPARTMENTS } from '../layout/catalog'
import type { OfficeLayout } from '../layout/types'
import type { DeskMarker } from '../scene/labels'
import { activeTaskFor, agentAtDesk } from './operations'
import type { Preserved, WorkforceLoadProblem } from './storage'
import type { Agent, AgentActivity, AgentDepartment, AgentStatus, AgentTask, TaskStatus, WorkforceState } from './types'

// Pure helpers for the workforce panel, so the components only render.

export type AgentFilter = { department: AgentDepartment | 'all'; status: AgentStatus | 'all' }
export type DeskOption = { id: string; label: string }
export type DeskGroup = { roomId: string | null; roomName: string; desks: DeskOption[] }
export type DeskStatus = { kind: 'none' } | { kind: 'assigned'; label: string; roomName: string } | { kind: 'unavailable'; deskId: string }

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = { idle: 'Idle', working: 'Working', thinking: 'Thinking', waiting: 'Waiting', error: 'Error', completed: 'Completed' }
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { queued: 'Queued', starting: 'Starting', running: 'Running', waiting_for_approval: 'Waiting for approval', completed: 'Completed', failed: 'Failed', cancelling: 'Cancelling', cancelled: 'Cancelled' }
export const AGENT_DEPARTMENTS = Object.keys(DEPARTMENTS).filter((id) => id !== 'meeting') as AgentDepartment[]

const OPEN_FLOOR = 'Open floor'
const TIMELINE_LIMIT = 20

export function filterAgents(agents: Agent[], f: AgentFilter): Agent[] {
  return agents.filter((a) => (f.department === 'all' || a.department === f.department) && (f.status === 'all' || a.status === f.status))
}

/** 'Desk 03' for the default desk-03 naming; any other id is shown as is. */
export const deskLabel = (id: string) => (/^desk-\d+$/.test(id) ? `Desk ${id.slice(5)}` : id)

const roomName = (layout: OfficeLayout, roomId: string | null) => (roomId === null ? OPEN_FLOOR : layout.rooms.find((r) => r.id === roomId)?.name ?? OPEN_FLOOR)

/** Free desks plus the agent's own, grouped by room in layout order with the open floor last. Empty groups are left out. */
export function deskOptions(layout: OfficeLayout, s: WorkforceState, agentId: string): DeskGroup[] {
  const heldByOthers = new Set(s.agents.filter((a) => a.id !== agentId && a.deskId !== null).map((a) => a.deskId))
  const free = layout.furniture.filter((f) => f.type === 'desk' && !heldByOthers.has(f.id))
  const groups: DeskGroup[] = [...layout.rooms.map((r) => r.id), null].map((roomId) => ({
    roomId,
    roomName: roomName(layout, roomId),
    desks: free.filter((f) => (roomId === null ? f.roomId === null || !layout.rooms.some((r) => r.id === f.roomId) : f.roomId === roomId)).map((f) => ({ id: f.id, label: deskLabel(f.id) })),
  }))
  return groups.filter((g) => g.desks.length > 0)
}

export function deskStatus(layout: OfficeLayout, agent: Agent): DeskStatus {
  if (agent.deskId === null) return { kind: 'none' }
  const desk = layout.furniture.find((f) => f.id === agent.deskId && f.type === 'desk')
  if (!desk) return { kind: 'unavailable', deskId: agent.deskId }
  return { kind: 'assigned', label: deskLabel(desk.id), roomName: roomName(layout, desk.roomId) }
}

export function agentTimeline(s: WorkforceState, agentId: string, limit = TIMELINE_LIMIT): AgentActivity[] {
  return s.activities.filter((a) => a.agentId === agentId).slice(-limit).reverse()
}

export function agentHistory(s: WorkforceState, agentId: string): AgentTask[] {
  return s.tasks.filter((t) => t.agentId === agentId).reverse()
}

/** Confirmation copy when removing would lose a task or its history; null when the agent can go without asking. */
export function removalPrompt(s: WorkforceState, agentId: string): { title: string; message: string } | null {
  const agent = s.agents.find((a) => a.id === agentId)
  if (!agent || !s.tasks.some((t) => t.agentId === agentId)) return null
  const active = activeTaskFor(s, agentId)
  const title = `Remove ${agent.name}?`
  return active
    ? { title, message: `${agent.name} is running "${active.title}". Removing the agent cancels the task and deletes its history.` }
    : { title, message: `This deletes ${agent.name} and its task history.` }
}

/** Local 24-hour HH:MM:SS. en-GB pins the digits and separators; the time zone stays the viewer's. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** One marker per agent whose desk exists in the layout, in layout order. Missing desks get none (the panel flags them). */
export function deskMarkers(layout: OfficeLayout, s: WorkforceState, selectedAgentId: string | null): DeskMarker[] {
  return layout.furniture.flatMap((f) => {
    const agent = f.type === 'desk' ? agentAtDesk(s, f.id) : undefined
    return agent ? [{ id: agent.id, label: agent.name, status: agent.status, x: f.x, z: f.z, selected: agent.id === selectedAgentId }] : []
  })
}

export function deskClickTarget(s: WorkforceState, deskId: string): { kind: 'open'; agentId: string } | { kind: 'assign'; deskId: string } {
  const agent = agentAtDesk(s, deskId)
  return agent ? { kind: 'open', agentId: agent.id } : { kind: 'assign', deskId }
}

/** Candidates for a free desk: agents without one first, then the rest (who would move). */
export function assignableAgents(s: WorkforceState): Agent[] {
  return [...s.agents.filter((a) => a.deskId === null), ...s.agents.filter((a) => a.deskId !== null)]
}

const PRESERVED_SENTENCE: Record<Preserved, string> = {
  'backup-created': 'The saved data was backed up.',
  'backup-exists': 'An earlier backup already exists, so this data was not backed up and your next change replaces it.',
  'left-in-place': 'That data is left untouched.',
}

/** The load notice, saying exactly what happened to data that couldn't be read. */
export function workforceNotice(problem: WorkforceLoadProblem, preserved: Preserved | null): string {
  if (problem === 'unavailable') return 'Browser storage is unavailable, so agent changes cannot be saved in this window.'
  const lead = problem === 'unsupported-version' ? 'Saved agents come from a newer version of the app, so none are shown.' : "Saved agents couldn't be loaded, so none are shown."
  return preserved ? `${lead} ${PRESERVED_SENTENCE[preserved]}` : lead
}
