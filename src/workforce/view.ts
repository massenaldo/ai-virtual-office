import { DEPARTMENTS, isAgentDepartmentId } from '../layout/catalog'
import type { OfficeLayout } from '../layout/types'
import { seatForDesk } from '../layout/seats'
import type { SceneCharacter } from '../scene/characterInstances'
import type { CharacterStatus } from '../scene/characterRig'
import type { DeskMarker } from '../scene/labels'
import type { PermissionRuleView } from './api'
import type { PermissionsState } from './permissions'
import type { ConnectionStatus, RuntimeEnvironment, WorkforceSnapshot } from './controller'
import { dayStartMs, jakartaDay } from '../office/jakartaClock'
import type { OfficeClock } from '../office/officeClock'
import type { RoutineAgent } from '../office/presence'
import { daySchedule } from '../office/schedule'
import { activeTaskFor, agentAtDesk } from './operations'
import type { Preserved, WorkforceLoadProblem } from './storage'
import type { Agent, AgentActivity, AgentDepartment, AgentStatus, AgentTask, TaskHold, TaskRuntime, TaskStatus, TaskUsage, WorkforceState } from './types'

// Pure helpers for the workforce panel, so the components only render.

export type AgentFilter = { department: AgentDepartment | 'all'; status: AgentStatus | 'all' }
export type DeskOption = { id: string; label: string }
export type DeskGroup = { roomId: string | null; roomName: string; desks: DeskOption[] }
export type DeskStatus = { kind: 'none' } | { kind: 'assigned'; label: string; roomName: string } | { kind: 'unavailable'; deskId: string }

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = { idle: 'Idle', working: 'Working', thinking: 'Thinking', waiting: 'Waiting', error: 'Error' }
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { queued: 'Queued', starting: 'Starting', running: 'Running', waiting_for_approval: 'Waiting for approval', completed: 'Completed', failed: 'Failed', cancelling: 'Cancelling', cancelled: 'Cancelled' }
export const AGENT_DEPARTMENTS = Object.keys(DEPARTMENTS).filter(isAgentDepartmentId) as AgentDepartment[]

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
  if (active?.hold) return { title, message: `${agent.name} has "${active.title}" waiting for a break. Removing the agent cancels the task and deletes its history.` }
  return active
    ? { title, message: `${agent.name} is running "${active.title}". Removing the agent cancels the task and deletes its history.` }
    : { title, message: `This deletes ${agent.name} and its task history.` }
}

/** `About $0.0123 (estimate) · 3 steps`; the cost has up to 4 decimals with trailing zeros trimmed to at least 2. */
export function formatUsage(usage: TaskUsage | null): string | null {
  if (!usage) return null
  const steps = `${usage.turns} ${usage.turns === 1 ? 'step' : 'steps'}`
  if (usage.costUsd > 0 && usage.costUsd < 0.0001) return `Less than $0.0001 (estimate) · ${steps}`
  const [whole, fraction = ''] = usage.costUsd.toFixed(4).split('.')
  return `About $${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')} (estimate) · ${steps}`
}

/** Local 24-hour HH:MM:SS. en-GB pins the digits and separators; the time zone stays the viewer's. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** One marker per agent whose desk exists in the layout, in layout order, placed at the seat. Missing desks get none (the panel flags them). */
export function deskMarkers(layout: OfficeLayout, s: WorkforceState, selectedAgentId: string | null): DeskMarker[] {
  return layout.furniture.flatMap((f) => {
    const agent = f.type === 'desk' ? agentAtDesk(s, f.id) : undefined
    if (!agent) return []
    // The label sits over the seat, not the desk, so it stays above the character.
    const seat = seatForDesk(layout, f)
    return [{ id: agent.id, label: agent.name, status: agent.status, x: seat.x, z: seat.z, seated: seat.seated, selected: agent.id === selectedAgentId, phase: markerPhase(activeTaskFor(s, agent.id)), held: heldOf(activeTaskFor(s, agent.id)) }]
  })
}

// Every agent status is mapped on purpose. A status this build does not know shows as idle rather than as a made-up action.
const CHARACTER_STATUS: Record<AgentStatus, CharacterStatus> = { idle: 'idle', working: 'working', thinking: 'thinking', waiting: 'waiting', error: 'error' }

/** When the agent's latest task finished, if it completed and the agent is idle; null for anything else, including an unreadable time. */
function finishedAt(s: WorkforceState, agent: Agent): number | null {
  if (agent.status !== 'idle' || agent.currentTaskId === null) return null
  const task = s.tasks.find((t) => t.id === agent.currentTaskId && t.agentId === agent.id)
  if (!task || task.status !== 'completed' || task.completedAt === null) return null
  const at = Date.parse(task.completedAt)
  return Number.isFinite(at) ? at : null
}

/** One character per desk that has an agent, in layout order, at the desk's seat. The agent is the one the desk's marker shows. */
export function deskCharacters(layout: OfficeLayout, s: WorkforceState): SceneCharacter[] {
  return layout.furniture.flatMap((f) => {
    const agent = f.type === 'desk' ? agentAtDesk(s, f.id) : undefined
    if (!agent) return []
    const seat = seatForDesk(layout, f)
    return [{
      id: agent.id,
      deskId: f.id,
      x: seat.x,
      z: seat.z,
      rotation: seat.rotation,
      seated: seat.seated,
      status: CHARACTER_STATUS[agent.status] ?? 'idle',
      doneAt: finishedAt(s, agent),
      accent: DEPARTMENTS[agent.department]?.color ?? DEPARTMENTS.executive.color,
    }]
  })
}

const timeOf = (iso: string | null): number | null => {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * What the routine needs to know about each agent, in office time (`clock.fromReal` turns the real task times into it). An active
 * task gives `activeSince`; the latest finished task gives `busyUntil`. An unreadable time counts as missing.
 */
export function routineAgents(s: WorkforceState, layout: OfficeLayout, clock: OfficeClock): RoutineAgent[] {
  void layout // the routine finds each desk in the layout itself; the argument keeps the call shape the same as the others
  return s.agents.map((agent) => {
    const active = activeTaskFor(s, agent.id)
    // A held task is waiting, not working: the agent keeps living its break until the task really starts.
    const startedReal = active && !active.hold ? (timeOf(active.startedAt) ?? timeOf(active.createdAt)) : null
    let endedReal: number | null = null
    for (const t of s.tasks) {
      // A task that never started (a held one that was cancelled) leaves the agent where it was.
      if (t.agentId !== agent.id || t === active || t.startedAt === null) continue
      const at = timeOf(t.completedAt)
      if (at !== null && (endedReal === null || at > endedReal)) endedReal = at
    }
    return {
      id: agent.id,
      deskId: agent.deskId,
      takesPrayerBreaks: agent.takesPrayerBreaks,
      activeSince: startedReal === null ? null : clock.fromReal(startedReal),
      busyUntil: endedReal === null ? null : clock.fromReal(endedReal),
    }
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

/** The first 12 hex characters of an approval's action digest, for display. */
export const shortDigest = (digest: string | null): string | null => (digest === null ? null : digest.slice(0, 12))

export const TASK_RUNTIME_LABEL: Record<TaskRuntime, string> = { mock: 'Simulated run', claude: 'Claude runtime' }

export type EnvironmentBadge = { label: string; title: string; tone: 'browser' | 'backend' | 'unavailable' }

/** The panel's runtime badge. The copy says plainly that no AI is run in the browser or mock modes. */
export function environmentBadge(env: RuntimeEnvironment): EnvironmentBadge {
  if (env.kind === 'browser') return { label: 'Mock · browser', title: 'Tasks are simulated in the browser. No AI is run.', tone: 'browser' }
  const claude = env.runtimes?.find((r) => r.kind === 'claude')
  if (claude && env.runtimes?.some((r) => r.kind === 'mock')) {
    const claudeText = claude.available ? 'available' : `not available (${claude.reason ?? 'reason unknown'})`
    return {
      label: claude.available ? 'Local backend · mock + Claude' : 'Local backend · mock + Claude (not available)',
      title: `Simulated (mock): available. Claude: ${claudeText}. Each task picks its runtime; the default is ${env.defaultRuntime === 'claude' ? 'Claude' : 'the mock'}.`,
      tone: claude.available ? 'backend' : 'unavailable',
    }
  }
  if (env.runtime === 'claude') {
    if (env.available === true) return { label: 'Local backend · Claude', title: 'Tasks run on the Claude Agent SDK. In this version the agent can read files in the workspace you pick and propose changes that you approve one by one; it cannot run anything.', tone: 'backend' }
    return { label: 'Local backend · Claude (not available)', title: `${env.reason ?? 'reason unknown'}. Tasks are refused.`, tone: 'unavailable' }
  }
  if (env.runtime === 'mock') return { label: 'Local backend · mock runtime', title: "Tasks run on the local backend's mock runtime. No AI is run.", tone: env.available === false ? 'unavailable' : 'backend' }
  return { label: 'Local backend', title: 'Connecting to the local backend.', tone: 'backend' }
}

export function environmentNote(env: RuntimeEnvironment): string | null {
  // With Claude registered next to the mock the note would be false: each task picks its runtime.
  if (env.kind === 'backend' && env.runtimes?.some((r) => r.kind === 'claude')) return null
  return env.kind === 'backend' && env.runtime === 'mock' ? 'Mock runtime only; no AI is run.' : null
}

/** The connection pill text; null in the browser mock, where there is no connection. */
export function connectionLabel(s: Pick<WorkforceSnapshot, 'connection' | 'lastSyncedAt'>): string | null {
  const labels: Record<ConnectionStatus, () => string | null> = {
    local: () => null,
    connecting: () => (s.lastSyncedAt === null ? 'Connecting…' : 'Reconnecting…'),
    live: () => 'Live',
    offline: () => (s.lastSyncedAt === null ? 'Offline · retrying' : `Offline · last synced ${formatTime(s.lastSyncedAt)} · retrying`),
    misconfigured: () => 'Not configured',
  }
  return labels[s.connection]()
}

export type MarkerPhase = 'queued' | 'starting' | 'waiting_for_approval' | 'cancelling'

/** The lifecycle phases that get their own desk-marker look; running and ended tasks are already shown by the agent status colour. */
export function markerPhase(task: AgentTask | undefined): MarkerPhase | null {
  return task && !task.hold && (task.status === 'queued' || task.status === 'starting' || task.status === 'waiting_for_approval' || task.status === 'cancelling') ? task.status : null
}

/** `On lunch · starts around 13:00` in Jakarta time, or the reason it still waits after its break. */
export function heldTaskText(hold: TaskHold): string {
  return hold.blockedBy ?? `${hold.label} · starts around ${clockText(jakartaDay(hold.untilMs), hold.untilMs)}`
}

const heldOf = (task: AgentTask | undefined): string | null => (task?.hold ? heldTaskText(task.hold) : null)

export function agentStatusText(s: WorkforceState, agent: Agent): string {
  const task = activeTaskFor(s, agent.id)
  const held = heldOf(task)
  if (held) return held
  const phase = markerPhase(task)
  return phase ? TASK_STATUS_LABEL[phase] : AGENT_STATUS_LABEL[agent.status]
}

export type ReviewSegment = { kind: 'text' | 'tab' | 'trail' | 'cr'; text: string }
export type ReviewLine = { no: number; segments: ReviewSegment[] }

/**
 * The lines of a review's text for display, numbered from 1, every one of them (nothing is cut). Tabs, trailing spaces and
 * a carriage return are their own segments so the pane can mark them; the characters themselves are never changed.
 */
export function formatReviewLines(text: string): ReviewLine[] {
  if (text === '') return []
  const pieces = text.split('\n')
  if (text.endsWith('\n')) pieces.pop()
  return pieces.map((raw, i) => {
    const cr = raw.endsWith('\r')
    const body = cr ? raw.slice(0, -1) : raw
    const trail = /[ ]+$/.exec(body)?.[0] ?? ''
    const main = trail ? body.slice(0, -trail.length) : body
    const segments: ReviewSegment[] = []
    // Every tab and every carriage return is its own marked segment, wherever it sits in the line.
    for (const part of main.split(/([\t\r])/)) if (part !== '') segments.push(part === '\t' ? { kind: 'tab', text: part } : part === '\r' ? { kind: 'cr', text: part } : { kind: 'text', text: part })
    if (trail) segments.push({ kind: 'trail', text: trail })
    if (cr) segments.push({ kind: 'cr', text: '\r' })
    return { no: i + 1, segments }
  })
}

/** Approve is available only after the full change has been opened; with no review (a simulated approval, Bash) it always is. */
export const approveEnabled = (review: unknown, opened: boolean): boolean => review === null || opened

/**
 * The scopes a person may give an allow for an approval. Execute and network tools are Once only, and so is an approval without a
 * digest (a simulated one: there is no exact action to grant from); the server refuses anything broader in both cases.
 */
export const allowedScopes = (tool: string, digest: string | null, onceOnly = false): Array<'once' | 'task' | 'agent'> => onceOnly || digest === null || ['Bash', 'WebFetch', 'WebSearch'].includes(tool) ? ['once'] : ['once', 'task', 'agent']

export type PermissionIcon = 'allowed' | 'denied' | 'ask' | 'expired' | 'revoked' | 'used' | 'ended'
/** The word and icon shown for a rule; colour only adds to them. */
export function permissionStateText(rule: PermissionRuleView): { label: string; icon: PermissionIcon } {
  if (rule.state === 'active') return rule.effect === 'allow' ? { label: 'Allowed', icon: 'allowed' } : rule.effect === 'deny' ? { label: 'Denied', icon: 'denied' } : { label: 'Approval required', icon: 'ask' }
  return { label: { expired: 'Expired', revoked: 'Revoked', used: 'Used', ended: 'Ended' }[rule.state], icon: rule.state }
}

export const PERMISSION_SCOPE_LABEL: Record<PermissionRuleView['scope'], string> = { global: 'All agents', agent: 'One agent', task: 'One task', once: 'One use' }

/** The Global tab shows global rules; an agent's tab shows every rule that names that agent (agent, task and once). */
export const rulesForTab = (rules: PermissionRuleView[], tab: string): PermissionRuleView[] => rules.filter((r) => (tab === 'global' ? r.scope === 'global' : r.agentId === tab))

export function revokePrompt(rule: PermissionRuleView, agentName: string | null): { title: string; message: string } {
  const covered = `${rule.effect === 'allow' ? 'Allow' : rule.effect === 'deny' ? 'Deny' : 'Ask'} ${rule.tool}${rule.pathPattern ? ` on ${rule.pathPattern}` : ''}`
  const lines = [`${covered}. Calls this rule covered are decided by the remaining rules; if none matches, they are denied.`]
  if (rule.createdBy === 'default') lines.push('This is a built-in default rule.')
  if (rule.scope === 'task' || rule.scope === 'once') lines.push('A call this rule allowed that is still running is stopped.')
  return { title: `Revoke ${rule.tool}${agentName ? ` for ${agentName}` : ''}?`, message: lines.join(' ') }
}

export const revokeAgentPrompt = (agentName: string, count: number): { title: string; message: string } => ({
  title: `Revoke all permissions for ${agentName}?`,
  message: `This revokes ${count} active ${count === 1 ? 'rule' : 'rules'} for ${agentName}, including grants for tasks that are running. Global rules stay.`,
})

/** Tasks that are waiting for a person's decision, with the agent they belong to. */
export function waitingApprovals(s: WorkforceState): Array<{ agentId: string; agentName: string; taskId: string; tool: string; summary: string }> {
  return s.tasks.flatMap((t) => {
    const agent = s.agents.find((a) => a.id === t.agentId)
    return t.status === 'waiting_for_approval' && t.pendingApproval && agent ? [{ agentId: agent.id, agentName: agent.name, taskId: t.id, tool: t.pendingApproval.tool, summary: t.pendingApproval.summary }] : []
  })
}

const SCOPE_VALUE = { once: 'allow_once', task: 'allow_task', agent: 'allow_agent' } as const
export const choiceFor = (scope: 'once' | 'task' | 'agent'): 'allow_once' | 'allow_task' | 'allow_agent' => SCOPE_VALUE[scope]

/** What an allow of this scope grants, in the server's terms. The tool and agent come from the pending approval, never from the person's typing. */
export function scopeSentence(scope: 'once' | 'task' | 'agent', tool: string, agentName: string): string {
  if (scope === 'once') return `Allow ${tool} once, for exactly this action.`
  const unseen = 'Later changes under it are not shown to you again.'
  return scope === 'task' ? `Allow ${tool} for the rest of this task. ${unseen}` : `Allow ${tool} for ${agentName} on every task until you revoke it. ${unseen}`
}

/** The chip in an agent's header: null in browser mode and before the first load, otherwise the pending state or the rule count. */
export function agentPermissionChip(permissions: PermissionsState | null, s: WorkforceState, agentId: string): string | null {
  if (!permissions?.loaded) return null
  if (waitingApprovals(s).some((w) => w.agentId === agentId)) return 'Approval required'
  const n = permissions.active.filter((r) => r.agentId === agentId).length
  return n === 0 ? 'No permission rules' : `${n} permission ${n === 1 ? 'rule' : 'rules'}`
}

/** The file name of an imported agent's source (stored as `<workspaceId>:<fileName>`); the workspace id is left out. Null when there is none. */
export function sourceFileName(sourceFile: string | null): string | null {
  const cut = sourceFile === null ? -1 : sourceFile.indexOf(':')
  return sourceFile !== null && cut > 0 && cut < sourceFile.length - 1 ? sourceFile.slice(cut + 1) : null
}

const clockText = (day: ReturnType<typeof jakartaDay>, ms: number) => {
  const m = Math.round((ms - dayStartMs(day)) / 60000)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** The agent's breaks for the Jakarta day that `nowMs` falls in, as `12:03` or `11:45–13:00` in Jakarta time. */
export function todaySchedule(agent: Agent, nowMs: number): { time: string; label: string }[] {
  const day = jakartaDay(nowMs)
  return daySchedule(agent, day).map((e) => ({
    time: e.kind === 'lunch' || e.kind === 'friday' ? `${clockText(day, e.startMs)}–${clockText(day, e.endMs)}` : clockText(day, e.startMs),
    label: e.label,
  }))
}
