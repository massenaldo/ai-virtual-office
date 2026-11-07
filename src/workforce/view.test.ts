import { describe, expect, it } from 'vitest'
import css from '../styles.css?raw'
import { createDefaultLayout } from '../layout/defaultLayout'
import type { OfficeLayout } from '../layout/types'
import { DEPARTMENTS } from '../layout/catalog'
import { createDemoWorkforce } from './demo'
import type { PermissionRuleView } from './api'
import { addActivity, applyRuntimeEvent, assignTask, cancelTask, markStarting } from './operations'
import type { TaskHold } from './types'
import type { RuntimeEnvironment } from './controller'
import { createOfficeClock } from '../office/officeClock'
import { AGENT_DEPARTMENTS, AGENT_STATUS_LABEL, agentHistory, assignableAgents, deskCharacters, deskClickTarget, deskMarkers, shortDigest, environmentBadge, environmentNote, connectionLabel, agentStatusText, workforceNotice, TASK_RUNTIME_LABEL, agentTimeline, deskOptions, deskStatus, filterAgents, formatTime, allowedScopes, permissionStateText, rulesForTab, scopeSentence, choiceFor, agentPermissionChip, revokePrompt, revokeAgentPrompt, waitingApprovals, removalPrompt, TASK_STATUS_LABEL, formatUsage, sourceFileName, todaySchedule, routineAgents, heldTaskText, heldStartError } from './view'

const NOW = '2026-10-30T09:00:00.000Z'
const layout = createDefaultLayout()
const demo = createDemoWorkforce(NOW)
const without = (l: OfficeLayout, id: string): OfficeLayout => ({ ...l, furniture: l.furniture.filter((f) => f.id !== id) })
const agent = (id: string) => demo.agents.find((a) => a.id === id)!

function withTask(agentId = 'agent-demo-pm') {
  const r = assignTask(demo, agentId, { title: 'Draft sprint plan', description: '' }, NOW)
  if (!r.ok) throw new Error(r.error)
  return { state: r.state, taskId: r.taskId }
}

describe('labels', () => {
  it('covers every status and department except the room departments', () => {
    expect(AGENT_STATUS_LABEL).toEqual({ idle: 'Idle', working: 'Working', thinking: 'Thinking', waiting: 'Waiting', error: 'Error' })
    expect(TASK_STATUS_LABEL).toEqual({ queued: 'Queued', starting: 'Starting', running: 'Running', waiting_for_approval: 'Waiting for approval', completed: 'Completed', failed: 'Failed', cancelling: 'Cancelling', cancelled: 'Cancelled' })
    for (const room of ['meeting', 'kitchen', 'dining', 'prayer']) expect(AGENT_DEPARTMENTS).not.toContain(room)
    expect(AGENT_DEPARTMENTS).toHaveLength(9)
    expect(AGENT_DEPARTMENTS[0]).toBe('executive')
  })
})

describe('filterAgents', () => {
  it('filters by department and status', () => {
    expect(filterAgents(demo.agents, { department: 'qa', status: 'all' }).map((a) => a.id)).toEqual(['agent-demo-qa'])
    expect(filterAgents(demo.agents, { department: 'all', status: 'working' })).toEqual([])
    expect(filterAgents(demo.agents, { department: 'all', status: 'idle' })).toHaveLength(6)
    expect(filterAgents(demo.agents, { department: 'all', status: 'all' })).toHaveLength(6)
  })
})

describe('deskOptions', () => {
  it("lists free desks by room plus the agent's own", () => {
    const groups = deskOptions(layout, demo, 'agent-demo-pm')
    const ids = (roomId: string | null) => groups.find((g) => g.roomId === roomId)?.desks.map((d) => d.id)
    expect(groups.map((g) => g.roomName)).toEqual(['CEO OFFICE', 'PROJECT MANAGEMENT', 'TECH LEAD', 'BACKEND ENGINEERING', 'Open floor'])
    expect(ids('room-ceo-office')).toEqual(['desk-01', 'desk-02'])
    expect(ids('room-project-management')).toEqual(['desk-03', 'desk-04'])
    expect(ids('room-tech-lead')).toEqual(['desk-06'])
    expect(ids(null)).toEqual(['desk-10', 'desk-12', 'desk-14'])
    expect(groups.flatMap((g) => g.desks).some((d) => d.id === 'desk-05')).toBe(false)
    expect(groups[1].desks[0]).toEqual({ id: 'desk-03', label: 'Desk 03' })
  })

  it('only offers desks that exist in the layout', () => {
    const groups = deskOptions(without(layout, 'desk-04'), demo, 'agent-demo-pm')
    expect(groups.flatMap((g) => g.desks).some((d) => d.id === 'desk-04')).toBe(false)
  })

  it('labels desks without the default naming by id', () => {
    const l: OfficeLayout = { ...layout, furniture: [...layout.furniture, { id: 'desk-a1b2c3d4', type: 'desk', x: 0, z: 0, rotation: 0, roomId: null }] }
    expect(deskOptions(l, demo, 'agent-demo-pm').at(-1)?.desks.at(-1)).toEqual({ id: 'desk-a1b2c3d4', label: 'desk-a1b2c3d4' })
  })
})

describe('deskStatus', () => {
  it('reports assigned, none and unavailable', () => {
    expect(deskStatus(layout, agent('agent-demo-pm'))).toEqual({ kind: 'assigned', label: 'Desk 03', roomName: 'PROJECT MANAGEMENT' })
    expect(deskStatus(layout, agent('agent-demo-qa'))).toEqual({ kind: 'assigned', label: 'Desk 13', roomName: 'Open floor' })
    expect(deskStatus(without(layout, 'desk-03'), agent('agent-demo-pm'))).toEqual({ kind: 'unavailable', deskId: 'desk-03' })
    expect(deskStatus(layout, { ...agent('agent-demo-pm'), deskId: null })).toEqual({ kind: 'none' })
  })

  it('treats a non-desk furniture id as unavailable', () => {
    expect(deskStatus(layout, { ...agent('agent-demo-pm'), deskId: 'chair-03' })).toEqual({ kind: 'unavailable', deskId: 'chair-03' })
  })
})

describe('timeline and history', () => {
  it('agentTimeline is newest first and limited', () => {
    let s = demo
    for (let i = 0; i < 25; i++) s = addActivity(s, { type: 'agent-updated', agentId: 'agent-demo-pm', taskId: null, message: `#${i}`, timestamp: NOW, source: 'mock' })
    const t = agentTimeline(s, 'agent-demo-pm')
    expect(t).toHaveLength(20)
    expect(t[0].message).toBe('#24')
    expect(agentTimeline(s, 'agent-demo-pm', 3).map((a) => a.message)).toEqual(['#24', '#23', '#22'])
    expect(agentTimeline(s, 'agent-demo-qa')).toHaveLength(1)
  })

  it('agentHistory is newest first', () => {
    const { state, taskId } = withTask()
    const second = assignTask(cancelTask(state, taskId, NOW), 'agent-demo-pm', { title: 'Second', description: '' }, NOW)
    if (!second.ok) throw new Error(second.error)
    expect(agentHistory(second.state, 'agent-demo-pm').map((t) => t.title)).toEqual(['Second', 'Draft sprint plan'])
    expect(agentHistory(second.state, 'agent-demo-qa')).toEqual([])
  })
})

describe('removalPrompt', () => {
  it('asks only when there is a task', () => {
    expect(removalPrompt(demo, 'agent-demo-pm')).toBeNull()
    const { state, taskId } = withTask()
    expect(removalPrompt(state, 'agent-demo-pm')).toEqual({ title: 'Remove Atlas?', message: 'Atlas is running "Draft sprint plan". Removing the agent cancels the task and deletes its history.' })
    expect(removalPrompt(cancelTask(state, taskId, NOW), 'agent-demo-pm')).toEqual({ title: 'Remove Atlas?', message: 'This deletes Atlas and its task history.' })
    expect(removalPrompt(demo, 'agent-x')).toBeNull()
  })
})

describe('formatTime', () => {
  it('gives HH:MM:SS', () => {
    expect(formatTime(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('deskMarkers', () => {
  it('lists agents on existing desks', () => {
    const markers = deskMarkers(layout, demo, null)
    expect(markers).toHaveLength(6)
    expect(markers.find((m) => m.id === 'agent-demo-pm')).toEqual({ id: 'agent-demo-pm', label: 'Atlas', status: 'idle', x: -2.7, z: -3.84, seated: true, selected: false, phase: null, held: null })
    const selected = deskMarkers(layout, demo, 'agent-demo-pm')
    expect(selected.filter((m) => m.selected).map((m) => m.id)).toEqual(['agent-demo-pm'])
  })

  it('skips missing desks and agents without one', () => {
    expect(deskMarkers(without(layout, 'desk-03'), demo, null)).toHaveLength(5)
    const s = { ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-qa' ? { ...a, deskId: null } : a.id === 'agent-demo-lead' ? { ...a, deskId: 'chair-03' } : a)) }
    expect(deskMarkers(layout, s, null).map((m) => m.id).sort()).toEqual(['agent-demo-backend', 'agent-demo-devops', 'agent-demo-frontend', 'agent-demo-pm'])
  })

  it('carries the live status', () => {
    const { state } = withTask('agent-demo-pm')
    const running = { ...state, agents: state.agents.map((a) => (a.id === 'agent-demo-pm' ? { ...a, status: 'working' as const } : a)) }
    expect(deskMarkers(layout, running, null).find((m) => m.id === 'agent-demo-pm')?.status).toBe('working')
  })
})

describe('deskCharacters', () => {
  const COMPLETED = '2026-10-30T09:00:05.000Z'
  const finished = (status: 'completed' | 'failed' | 'cancelled', completedAt: string | null, agentStatus: 'idle' | 'working' = 'idle') => {
    const { state, taskId } = withTask('agent-demo-pm')
    return {
      ...state,
      agents: state.agents.map((a) => (a.id === 'agent-demo-pm' ? { ...a, status: agentStatus } : a)),
      tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status, completedAt } : t)),
    }
  }
  const pm = (s = demo, l = layout) => deskCharacters(l, s).find((c) => c.id === 'agent-demo-pm')

  it('one character per occupied desk at its seat', () => {
    const characters = deskCharacters(layout, demo)
    expect(characters).toHaveLength(6)
    expect(pm()).toEqual({ id: 'agent-demo-pm', deskId: 'desk-03', x: -2.7, z: -3.84, rotation: 0, seated: true, status: 'idle', doneAt: null, accent: DEPARTMENTS['project-management'].color })
  })

  it('no character for an agent with no desk or a missing desk', () => {
    expect(deskCharacters(without(layout, 'desk-03'), demo)).toHaveLength(5)
    const s = { ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-qa' ? { ...a, deskId: null } : a)) }
    expect(deskCharacters(layout, s).map((c) => c.id)).not.toContain('agent-demo-qa')
  })

  it('two agents on one desk give one character, the same agent the marker shows', () => {
    const s = { ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-qa' ? { ...a, deskId: 'desk-03' } : a)) }
    const characters = deskCharacters(layout, s).filter((c) => c.deskId === 'desk-03')
    expect(characters).toHaveLength(1)
    expect(characters[0].id).toBe(deskMarkers(layout, s, null).find((m) => m.x === characters[0].x && m.z === characters[0].z)?.id)
  })

  it('accent is the department colour', () => {
    for (const c of deskCharacters(layout, demo)) expect(c.accent).toBe(DEPARTMENTS[agent(c.id).department].color)
  })

  it('maps every agent status, and an unknown one to idle', () => {
    const status = (st: string) => pm({ ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-pm' ? { ...a, status: st as 'idle' } : a)) })?.status
    expect(['idle', 'working', 'thinking', 'waiting', 'error'].map(status)).toEqual(['idle', 'working', 'thinking', 'waiting', 'error'])
    expect(status('sleeping')).toBe('idle')
  })

  it('doneAt is the time of a completed current task of an idle agent', () => {
    expect(pm(finished('completed', COMPLETED))?.doneAt).toBe(Date.parse(COMPLETED))
  })

  it('doneAt is null for a failed or cancelled task, or a working agent', () => {
    expect(pm(finished('failed', COMPLETED))?.doneAt).toBeNull()
    expect(pm(finished('cancelled', COMPLETED))?.doneAt).toBeNull()
    expect(pm(finished('completed', COMPLETED, 'working'))?.doneAt).toBeNull()
  })

  it('an unparseable completedAt gives doneAt null', () => {
    expect(pm(finished('completed', 'not a date'))?.doneAt).toBeNull()
    expect(pm(finished('completed', null))?.doneAt).toBeNull()
  })
})

describe('deskClickTarget', () => {
  it('opens the agent at a desk or offers to assign', () => {
    expect(deskClickTarget(demo, 'desk-03')).toEqual({ kind: 'open', agentId: 'agent-demo-pm' })
    expect(deskClickTarget(demo, 'desk-04')).toEqual({ kind: 'assign', deskId: 'desk-04' })
  })
})

describe('assignableAgents', () => {
  it('puts agents without a desk first', () => {
    const s = { ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-qa' || a.id === 'agent-demo-lead' ? { ...a, deskId: null } : a)) }
    expect(assignableAgents(s).map((a) => a.id)).toEqual(['agent-demo-lead', 'agent-demo-qa', 'agent-demo-pm', 'agent-demo-backend', 'agent-demo-frontend', 'agent-demo-devops'])
  })
})

describe('workforceNotice', () => {
  it('says exactly what happened to unreadable data', () => {
    expect(workforceNotice('corrupt', 'backup-created')).toBe("Saved agents couldn't be loaded, so none are shown. The saved data was backed up.")
    expect(workforceNotice('corrupt', 'backup-exists')).toBe("Saved agents couldn't be loaded, so none are shown. An earlier backup already exists, so this data was not backed up and your next change replaces it.")
    expect(workforceNotice('corrupt', 'left-in-place')).toBe("Saved agents couldn't be loaded, so none are shown. That data is left untouched.")
    expect(workforceNotice('unsupported-version', 'backup-created')).toBe('Saved agents come from a newer version of the app, so none are shown. The saved data was backed up.')
    expect(workforceNotice('unavailable', null)).toBe('Browser storage is unavailable, so agent changes cannot be saved in this window.')
  })
})

describe('runtime indicator and lifecycle labels', () => {
  const mock = { kind: 'backend', runtime: 'mock', available: true, reason: null } as const

  it('environmentBadge names each environment', () => {
    expect(environmentBadge({ kind: 'browser' })).toEqual({ label: 'Mock · browser', title: 'Tasks are simulated in the browser. No AI is run.', tone: 'browser' })
    expect(environmentBadge(mock)).toMatchObject({ label: 'Local backend · mock runtime', tone: 'backend', title: "Tasks run on the local backend's mock runtime. No AI is run." })
    expect(environmentBadge({ kind: 'backend', runtime: 'claude', available: false, reason: 'Claude Agent SDK not installed' })).toEqual({ label: 'Local backend · Claude (not available)', title: 'Claude Agent SDK not installed. Tasks are refused.', tone: 'unavailable' })
    expect(environmentBadge({ kind: 'backend', runtime: 'claude', available: true, reason: null })).toEqual({ label: 'Local backend · Claude', title: 'Tasks run on the Claude Agent SDK. In this version the agent can read files in the workspace you pick and propose changes that you approve one by one; it cannot run anything.', tone: 'backend' })
    expect(environmentBadge({ kind: 'backend', runtime: 'claude', available: false, reason: null }).title).toBe('reason unknown. Tasks are refused.')
    expect(environmentBadge({ kind: 'backend', runtime: null, available: null, reason: null }).label).toBe('Local backend')
  })

  it('environmentBadge names both runtimes when both are registered', () => {
    const both = (claude: { available: boolean; reason: string | null }, defaultRuntime: 'mock' | 'claude' = 'mock') => ({ kind: 'backend', runtime: defaultRuntime, available: true, reason: null, defaultRuntime, runtimes: [{ kind: 'mock', available: true, reason: null }, { kind: 'claude', ...claude }] }) satisfies RuntimeEnvironment
    expect(environmentBadge(both({ available: true, reason: null }))).toMatchObject({ label: 'Local backend · mock + Claude', tone: 'backend' })
    expect(environmentBadge(both({ available: true, reason: null })).title).toContain('Simulated (mock): available')
    expect(environmentBadge(both({ available: true, reason: null })).title).toContain('Claude: available')
    const off = environmentBadge(both({ available: false, reason: 'Claude Agent SDK not installed' }))
    expect(off).toMatchObject({ label: 'Local backend · mock + Claude (not available)', tone: 'unavailable' })
    expect(off.title).toContain('Claude: not available (Claude Agent SDK not installed)')
    expect(environmentBadge({ ...mock, runtimes: [{ kind: 'mock', available: true, reason: null }], defaultRuntime: 'mock' }).label).toBe('Local backend · mock runtime')
  })

  it('environmentNote says mock runtime only for the backend mock', () => {
    expect(environmentNote(mock)).toBe('Mock runtime only; no AI is run.')
    expect(environmentNote({ kind: 'browser' })).toBeNull()
    expect(environmentNote({ kind: 'backend', runtime: 'claude', available: false, reason: null })).toBeNull()
  })

  it('environmentNote says nothing when Claude is registered next to the mock, and keeps its text for a mock-only backend', () => {
    const runtimes = [{ kind: 'mock' as const, available: true, reason: null }, { kind: 'claude' as const, available: true, reason: null }]
    expect(environmentNote({ ...mock, runtimes, defaultRuntime: 'mock' })).toBeNull()
    expect(environmentNote({ ...mock, runtimes: [runtimes[0]], defaultRuntime: 'mock' })).toBe('Mock runtime only; no AI is run.')
    expect(environmentNote(mock)).toBe('Mock runtime only; no AI is run.')
  })

  it('connectionLabel covers every connection status', () => {
    const T = '2026-10-31T09:15:30.000Z'
    expect(connectionLabel({ connection: 'local', lastSyncedAt: null })).toBeNull()
    expect(connectionLabel({ connection: 'connecting', lastSyncedAt: null })).toBe('Connecting…')
    expect(connectionLabel({ connection: 'connecting', lastSyncedAt: T })).toBe('Reconnecting…')
    expect(connectionLabel({ connection: 'live', lastSyncedAt: T })).toBe('Live')
    expect(connectionLabel({ connection: 'offline', lastSyncedAt: null })).toBe('Offline · retrying')
    expect(connectionLabel({ connection: 'offline', lastSyncedAt: T })).toBe(`Offline · last synced ${formatTime(T)} · retrying`)
    expect(connectionLabel({ connection: 'misconfigured', lastSyncedAt: null })).toBe('Not configured')
  })

  it('agentStatusText prefers the lifecycle phase', () => {
    const { state, taskId } = withTask('agent-demo-pm')
    const withStatus = (status: 'waiting_for_approval' | 'cancelling' | 'starting' | 'running') => ({ ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) })
    const pm = (s: typeof state) => s.agents.find((a) => a.id === 'agent-demo-pm')!
    expect(agentStatusText(withStatus('waiting_for_approval'), pm(withStatus('waiting_for_approval')))).toBe('Waiting for approval')
    expect(agentStatusText(withStatus('cancelling'), pm(withStatus('cancelling')))).toBe('Cancelling')
    expect(agentStatusText(withStatus('starting'), pm(withStatus('starting')))).toBe('Starting')
    const running = withStatus('running')
    expect(agentStatusText(running, { ...pm(running), status: 'working' })).toBe('Working')
    expect(agentStatusText(demo, agent('agent-demo-qa'))).toBe('Idle')
  })

  it('deskMarkers carry the active task phase', () => {
    const { state, taskId } = withTask('agent-demo-pm')
    const waiting = { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: 'waiting_for_approval' as const } : t)) }
    expect(deskMarkers(layout, waiting, null).find((m) => m.id === 'agent-demo-pm')?.phase).toBe('waiting_for_approval')
    expect(deskMarkers(layout, demo, null).every((m) => m.phase === null)).toBe(true)
  })

  it('labels where a task ran', () => {
    expect(TASK_RUNTIME_LABEL).toEqual({ mock: 'Simulated run', claude: 'Claude runtime' })
  })

  it('styles define a marker rule for every phase', () => {
    for (const p of ['queued', 'starting', 'waiting_for_approval', 'cancelling']) expect(css).toContain(`.desk-marker.phase-${p}`)
  })
})

describe('shortDigest', () => {
  it('shows the first 12 hex characters, or nothing', () => {
    expect(shortDigest('0123456789abcdef'.repeat(4))).toBe('0123456789ab')
    expect(shortDigest(null)).toBeNull()
  })
})


describe('allowedScopes', () => {
  const DIGEST = 'ab'.repeat(32)
  it('offers every scope for file tools with a real action', () => {
    for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) expect(allowedScopes(tool, DIGEST)).toEqual(['once', 'task', 'agent'])
  })
  it('offers Once only for execute and network tools', () => {
    for (const tool of ['Bash', 'WebFetch', 'WebSearch']) expect(allowedScopes(tool, DIGEST)).toEqual(['once'])
  })
  it('offers Once only when the approval has no digest (a simulated request)', () => {
    expect(allowedScopes('Write', null)).toEqual(['once'])
    expect(allowedScopes('Write', DIGEST, true)).toEqual(['once'])
    expect(allowedScopes('Edit', DIGEST, false)).toEqual(['once', 'task', 'agent'])
  })
})

const prule = (over: Partial<PermissionRuleView> = {}): PermissionRuleView => ({ id: 'p1', scope: 'global', effect: 'allow', tool: 'Read', agentId: null, taskId: null, pathPattern: null, createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active', ...over })

describe('permissionStateText', () => {
  it('names an active rule by its effect, with a word and an icon', () => {
    expect(permissionStateText(prule({ effect: 'allow' }))).toEqual({ label: 'Allowed', icon: 'allowed' })
    expect(permissionStateText(prule({ effect: 'deny' }))).toEqual({ label: 'Denied', icon: 'denied' })
    expect(permissionStateText(prule({ effect: 'ask' }))).toEqual({ label: 'Approval required', icon: 'ask' })
  })
  it('names an inactive rule by how it ended, whatever its effect', () => {
    for (const state of ['expired', 'revoked', 'used', 'ended'] as const) expect(permissionStateText(prule({ state, effect: 'deny' }))).toEqual({ label: { expired: 'Expired', revoked: 'Revoked', used: 'Used', ended: 'Ended' }[state], icon: state })
  })
})

describe('rulesForTab', () => {
  const rules = [prule({ id: 'g' }), prule({ id: 'a1', scope: 'agent', agentId: 'ag1' }), prule({ id: 't1', scope: 'task', agentId: 'ag1', taskId: 'tk' }), prule({ id: 'a2', scope: 'agent', agentId: 'ag2' })]
  it('the global tab lists global rules only', () => expect(rulesForTab(rules, 'global').map((r) => r.id)).toEqual(['g']))
  it('an agent tab lists every rule of that agent, whatever its scope', () => expect(rulesForTab(rules, 'ag1').map((r) => r.id)).toEqual(['a1', 't1']))
  it('an unknown agent has none', () => expect(rulesForTab(rules, 'nobody')).toEqual([]))
})

describe('revokePrompt', () => {
  it('names the tool and what the rule covered', () => {
    const p = revokePrompt(prule({ scope: 'agent', tool: 'Write', pathPattern: 'src/**', agentId: 'ag1' }), 'Nova')
    expect(p.title).toBe('Revoke Write for Nova?')
    expect(p.message).toContain('src/**')
    expect(p.message).toContain('denied')
  })
  it('says a built-in default can be revoked and what follows', () => {
    expect(revokePrompt(prule({ createdBy: 'default' }), null).message).toContain('built-in')
  })
  it('warns that a task or once rule also stops a call that is running', () => {
    expect(revokePrompt(prule({ scope: 'task', taskId: 'tk', agentId: 'ag1' }), 'Nova').message).toContain('running')
    expect(revokePrompt(prule({ scope: 'global' }), null).message).not.toContain('running')
  })
})

describe('revokeAgentPrompt', () => {
  it('counts the rules', () => {
    expect(revokeAgentPrompt('Nova', 1)).toEqual({ title: 'Revoke all permissions for Nova?', message: 'This revokes 1 active rule for Nova, including grants for tasks that are running. Global rules stay.' })
    expect(revokeAgentPrompt('Nova', 3).message).toContain('3 active rules')
  })
})

describe('waitingApprovals', () => {
  it('lists tasks that wait for a decision, with their agent', () => {
    const s = structuredClone(demo)
    const t = { ...s.tasks[0] ?? ({} as never) }
    const agent = s.agents[0]
    const waiting = { ...t, id: 'tk-w', agentId: agent.id, status: 'waiting_for_approval' as const, pendingApproval: { id: 'ap', tool: 'Write', summary: 'Write src/a.ts', requestedAt: NOW, digest: null, review: null, onceOnly: false } }
    expect(waitingApprovals({ ...s, tasks: [waiting] })).toEqual([{ agentId: agent.id, agentName: agent.name, taskId: 'tk-w', tool: 'Write', summary: 'Write src/a.ts' }])
    expect(waitingApprovals({ ...s, tasks: [{ ...waiting, status: 'running', pendingApproval: null }] })).toEqual([])
  })
})

describe('scopeSentence', () => {
  it('says exactly what each scope grants', () => {
    expect(scopeSentence('once', 'Write', 'Nova')).toBe('Allow Write once, for exactly this action.')
    expect(scopeSentence('task', 'Write', 'Nova')).toBe('Allow Write for the rest of this task. Later changes under it are not shown to you again.')
    expect(scopeSentence('agent', 'Write', 'Nova')).toBe('Allow Write for Nova on every task until you revoke it. Later changes under it are not shown to you again.')
  })
})

describe('choiceFor', () => {
  it('maps a scope to the value the server takes', () => {
    expect(choiceFor('once')).toBe('allow_once')
    expect(choiceFor('task')).toBe('allow_task')
    expect(choiceFor('agent')).toBe('allow_agent')
  })
})

describe('agentPermissionChip', () => {
  const perms = (rules: PermissionRuleView[]) => ({ active: rules, history: [], loaded: true, error: null })
  const waitingState = (agentId: string) => ({ ...demo, tasks: [{ ...demo.tasks[0], id: 'tk', agentId, status: 'waiting_for_approval' as const, pendingApproval: { id: 'ap', tool: 'Write', summary: 's', requestedAt: NOW, digest: null, review: null, onceOnly: false } }] })
  it('is absent without a backend', () => expect(agentPermissionChip(null, demo, 'a')).toBeNull())
  it('counts the active rules that name the agent', () => {
    const rules = [prule({ id: '1', scope: 'agent', agentId: 'a' }), prule({ id: '2', scope: 'task', agentId: 'a', taskId: 't' }), prule({ id: '3', scope: 'agent', agentId: 'b' }), prule({ id: '4' })]
    expect(agentPermissionChip(perms(rules), demo, 'a')).toBe('2 permission rules')
    expect(agentPermissionChip(perms(rules.slice(0, 1)), demo, 'a')).toBe('1 permission rule')
    expect(agentPermissionChip(perms([]), demo, 'a')).toBe('No permission rules')
  })
  it('says an approval is required while the agent waits for one', () => {
    const [one, two] = demo.agents
    expect(agentPermissionChip(perms([]), waitingState(one.id), one.id)).toBe('Approval required')
    expect(agentPermissionChip(perms([]), waitingState(one.id), two.id)).toBe('No permission rules')
  })
  it('says nothing before the first load', () => expect(agentPermissionChip({ active: [], history: [], loaded: false, error: null }, demo, 'a')).toBeNull())
})

describe('formatUsage', () => {
  it('is null without usage', () => {
    expect(formatUsage(null)).toBeNull()
  })

  it.each([
    [{ turns: 3, costUsd: 0.0123 }, 'About $0.0123 (estimate) · 3 steps'],
    [{ turns: 1, costUsd: 0.5 }, 'About $0.50 (estimate) · 1 step'],
    [{ turns: 0, costUsd: 0 }, 'About $0.00 (estimate) · 0 steps'],
    [{ turns: 2, costUsd: 0.00004 }, 'Less than $0.0001 (estimate) · 2 steps'],
    [{ turns: 2, costUsd: 0.0001 }, 'About $0.0001 (estimate) · 2 steps'],
    [{ turns: 2, costUsd: 0.12345 }, 'About $0.1235 (estimate) · 2 steps'],
    [{ turns: 2, costUsd: 0.1 }, 'About $0.10 (estimate) · 2 steps'],
    [{ turns: 2, costUsd: 12 }, 'About $12.00 (estimate) · 2 steps'],
    [{ turns: 2, costUsd: 0.125 }, 'About $0.125 (estimate) · 2 steps'],
  ])('formats %j', (usage, text) => {
    expect(formatUsage(usage)).toBe(text)
  })
})

describe('sourceFileName', () => {
  it('drops the workspace id and keeps a file name that has a colon', () => {
    expect(sourceFileName('sandbox:a.md')).toBe('a.md')
    expect(sourceFileName('sandbox:a:b.md')).toBe('a:b.md')
    expect(sourceFileName(null)).toBeNull()
    expect(sourceFileName('broken')).toBeNull()
  })
})

describe('todaySchedule', () => {
  const agentOn = { ...agent('agent-demo-pm'), takesPrayerBreaks: true }
  // 2026-11-06 is a Friday in Jakarta, even though it is still Thursday evening in New York.
  const FRIDAY_NOON = Date.parse('2026-11-06T12:00:00+07:00')
  it('lists the day in Jakarta time, in order, with ranges for lunch and the Friday window', () => {
    const rows = todaySchedule(agentOn, FRIDAY_NOON)
    expect(rows.every((r) => /^\d\d:\d\d(–\d\d:\d\d)?$/.test(r.time))).toBe(true)
    expect(rows.map((r) => r.time)).toEqual([...rows.map((r) => r.time)].sort())
    expect(rows).toContainEqual({ time: '11:45–13:00', label: 'Friday prayer and lunch' })
    expect(rows.filter((r) => r.label === 'Praying')).toHaveLength(4)
  })
  it('follows the Jakarta date at the day boundary, not the viewer', () => {
    const justBefore = todaySchedule(agentOn, Date.parse('2026-11-06T23:59:00+07:00'))
    const justAfter = todaySchedule(agentOn, Date.parse('2026-11-07T00:01:00+07:00'))
    expect(justBefore.some((r) => r.label === 'Friday prayer and lunch')).toBe(true)
    expect(justAfter.some((r) => r.label === 'Friday prayer and lunch')).toBe(false)
    expect(justAfter.some((r) => r.label === 'On lunch')).toBe(true)
  })
  it('has no prayers when the agent does not take prayer breaks', () => {
    const rows = todaySchedule({ ...agentOn, takesPrayerBreaks: false }, FRIDAY_NOON)
    expect(rows.some((r) => r.label === 'Praying' || r.label === 'Friday prayer and lunch')).toBe(false)
    expect(rows.some((r) => r.label === 'On lunch')).toBe(true)
  })
})

describe('routineAgents', () => {
  const SERVER = Date.parse('2026-11-07T05:00:00.000Z')
  const REAL = Date.parse('2026-11-07T04:00:00.000Z')
  // The office is an hour ahead of the real clock, at normal speed.
  const clock = createOfficeClock({ nowMs: SERVER, speed: 1, routine: true }, () => REAL)
  const iso = (ms: number) => new Date(ms).toISOString()
  const ofAgent = (s: typeof demo, id: string) => routineAgents(s, layout, clock).find((r) => r.id === id)!

  it('gives one entry per agent with its desk and prayer setting', () => {
    const list = routineAgents(demo, layout, clock)
    expect(list).toHaveLength(demo.agents.length)
    const pm = list.find((r) => r.id === 'agent-demo-pm')!
    expect(pm).toEqual({ id: 'agent-demo-pm', deskId: 'desk-03', takesPrayerBreaks: agent('agent-demo-pm').takesPrayerBreaks, activeSince: null, busyUntil: null })
  })

  it('gives activeSince for an active task and busyUntil for a finished one, in office time', () => {
    const { state, taskId } = withTask('agent-demo-pm')
    const startedReal = REAL - 60_000
    const running = { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: 'running' as const, startedAt: iso(startedReal) } : t)) }
    expect(ofAgent(running, 'agent-demo-pm').activeSince).toBe(clock.fromReal(startedReal))
    expect(ofAgent(running, 'agent-demo-pm').activeSince).toBe(SERVER - 60_000)
    const endedReal = REAL - 30_000
    const done = { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: 'completed' as const, startedAt: iso(startedReal), completedAt: iso(endedReal) } : t)) }
    const r = ofAgent(done, 'agent-demo-pm')
    expect(r.activeSince).toBeNull()
    expect(r.busyUntil).toBe(SERVER - 30_000)
  })

  it('a queued task that has not started counts from when it was made', () => {
    const { state } = withTask('agent-demo-pm')
    expect(ofAgent(state, 'agent-demo-pm').activeSince).toBe(clock.fromReal(Date.parse(NOW)))
  })

  it('ignores an unreadable time, and uses the latest of several finished tasks', () => {
    const { state, taskId } = withTask('agent-demo-pm')
    const broken = { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, status: 'failed' as const, completedAt: 'not a date' } : t)) }
    expect(ofAgent(broken, 'agent-demo-pm').busyUntil).toBeNull()
    const base = state.tasks.find((t) => t.id === taskId)!
    const began = { startedAt: iso(REAL - 120_000) }
    const two = { ...state, tasks: [{ ...base, ...began, status: 'completed' as const, completedAt: iso(REAL - 90_000) }, { ...base, ...began, id: 'task-b', status: 'cancelled' as const, completedAt: iso(REAL - 10_000) }] }
    expect(ofAgent(two, 'agent-demo-pm').busyUntil).toBe(SERVER - 10_000)
  })

  it('an ordinary task that failed while starting still counts towards busyUntil', () => {
    const { state, taskId } = withTask('agent-demo-pm')
    const starting = markStarting(state, taskId, iso(REAL - 20_000))
    const failed = applyRuntimeEvent(starting, { type: 'failed', taskId, error: 'refused' }, iso(REAL - 10_000), 'mock')
    expect(failed.tasks.find((t) => t.id === taskId)).toMatchObject({ status: 'failed', startedAt: iso(REAL - 20_000) })
    expect(ofAgent(failed, 'agent-demo-pm').busyUntil).toBe(SERVER - 10_000)
  })

  it('a missing desk becomes a null desk', () => {
    const s = { ...demo, agents: demo.agents.map((a) => (a.id === 'agent-demo-qa' ? { ...a, deskId: null } : a)) }
    expect(ofAgent(s, 'agent-demo-qa').deskId).toBeNull()
  })
})

describe('held tasks', () => {
  const LUNCH_END = Date.parse('2026-11-09T13:00:00+07:00')
  const HOLD: TaskHold = { label: 'On lunch', untilMs: LUNCH_END, blockedBy: null }
  function held(agentId = 'agent-demo-pm') {
    const r = assignTask(demo, agentId, { title: 'Draft sprint plan', description: '' }, NOW, { hold: HOLD })
    if (!r.ok) throw new Error(r.error)
    return { state: r.state, taskId: r.taskId }
  }

  it('heldTaskText names the break and the Jakarta time it ends', () => {
    expect(heldTaskText(HOLD)).toBe('On lunch · starts around 13:00')
    expect(heldTaskText({ label: 'Praying', untilMs: Date.parse('2026-11-09T15:20:00+07:00'), blockedBy: null })).toBe('Praying · starts around 15:20')
  })
  it('heldTaskText stays Jakarta time whatever the viewer zone is', () => {
    const was = process.env.TZ
    try {
      for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz
        expect(heldTaskText(HOLD)).toBe('On lunch · starts around 13:00')
      }
    } finally {
      if (was === undefined) delete process.env.TZ
      else process.env.TZ = was
    }
  })
  it('heldTaskText gives blockedBy when set', () => {
    expect(heldTaskText({ ...HOLD, blockedBy: 'Waiting for a free Claude slot. It starts as soon as one finishes.' })).toBe('Waiting for a free Claude slot. It starts as soon as one finishes.')
  })
  it('agentStatusText and deskMarkers use it, and the marker has no task phase', () => {
    const { state } = held()
    const pm = state.agents.find((a) => a.id === 'agent-demo-pm')!
    expect(agentStatusText(state, pm)).toBe('On lunch · starts around 13:00')
    const marker = deskMarkers(layout, state, null).find((m) => m.id === 'agent-demo-pm')!
    expect(marker).toMatchObject({ phase: null, held: 'On lunch · starts around 13:00' })
    expect(deskMarkers(layout, demo, null).every((m) => m.held === null)).toBe(true)
  })
  it('removalPrompt says the task is waiting for a break', () => {
    expect(removalPrompt(held().state, 'agent-demo-pm')).toEqual({ title: 'Remove Atlas?', message: 'Atlas has "Draft sprint plan" waiting for a break. Removing the agent cancels the task and deletes its history.' })
  })

  it('a refused Start now shows only while the task is still held, and only for that task', () => {
    const { state, taskId } = held()
    const task = state.tasks.find((t) => t.id === taskId)!
    const refusal = { taskId, error: 'A Claude task is already running, which is the limit. Wait for one to finish.' }
    expect(heldStartError(refusal, task)).toBe(refusal.error)
    expect(heldStartError(refusal, markStarting(state, taskId, NOW).tasks[0])).toBeNull()
    expect(heldStartError({ ...refusal, taskId: 'other' }, task)).toBeNull()
    expect(heldStartError(null, task)).toBeNull()
    expect(heldStartError(refusal, undefined)).toBeNull()
  })

  describe('routineAgents', () => {
    const SERVER = Date.parse('2026-11-07T05:00:00.000Z')
    const REAL = Date.parse('2026-11-07T04:00:00.000Z')
    const clock = createOfficeClock({ nowMs: SERVER, speed: 1, routine: true }, () => REAL)
    const ofPm = (s: typeof demo) => routineAgents(s, layout, clock).find((r) => r.id === 'agent-demo-pm')!

    it('a held task is not active, so the agent keeps living its break', () => {
      expect(ofPm(held().state)).toMatchObject({ activeSince: null, busyUntil: null })
    })
    it('a held task that was released counts from the release', () => {
      const { state, taskId } = held()
      const releasedAt = new Date(REAL - 30_000).toISOString()
      const started = markStarting(state, taskId, releasedAt)
      expect(ofPm(started).activeSince).toBe(clock.fromReal(REAL - 30_000))
    })
    it('cancelling a held task leaves busyUntil unchanged', () => {
      const { state, taskId } = held()
      const before = ofPm(state)
      const cancelled = cancelTask(state, taskId, new Date(REAL - 10_000).toISOString())
      expect(ofPm(cancelled)).toEqual(before)
    })
  })
})
