import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../layout/defaultLayout'
import type { PermissionRuleView, RuntimeStatus } from '../api'
import type { RuntimeEnvironment, WorkforceController } from '../controller'
import { createDemoWorkforce } from '../demo'
import { emptyPermissions, withLists, type PermissionsState } from '../permissions'
import type { TaskHold, ToolReview } from '../types'
import type { Workforce } from '../useWorkforce'
import { applyRuntimeEvent, assignTask, markStarting, recoverInterruptedTasks } from '../operations'
import AgentDetail, { startHeldNow, TaskForm } from './AgentDetail'
import { createOfficeClock } from '../../office/officeClock'
import { OfficeClockContext } from '../officeClockContext'

const NOW = '2026-11-03T09:00:00.000Z'
const layout = createDefaultLayout()
const demo = createDemoWorkforce(NOW)
const agent = demo.agents[0]
const review: ToolReview = { kind: 'write', path: 'src/a.ts', bytes: 3, lines: 1, content: 'abc', workspaceId: 'sandbox', digest: 'ab'.repeat(32) }

const waiting = (tool: string, withReview: ToolReview | null): typeof demo => ({
  ...demo,
  tasks: [{ ...(demo.tasks[0] ?? ({} as never)), id: 'tk', agentId: agent.id, title: 'T', description: '', status: 'waiting_for_approval' as const, pendingApproval: { id: 'ap1', tool, summary: `${tool} src/a.ts`, requestedAt: NOW, digest: withReview?.digest ?? null, review: withReview, onceOnly: false } }],
  agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'waiting' as const } : a)),
})

const view = (state: typeof demo, permissions: PermissionsState | null, environment?: RuntimeEnvironment) =>
  renderToStaticMarkup(<AgentDetail workforce={{ state, permissions, environment, actions: {} as WorkforceController } as unknown as Workforce} layout={layout} agent={state.agents.find((a) => a.id === agent.id)!} onBack={() => {}} onEdit={() => {}} onRemove={() => {}} onFocusDesk={() => {}}/>)

const loaded = (rules: PermissionRuleView[] = []) => withLists(emptyPermissions(), rules, [])

describe('AgentDetail approval card', () => {
  it('keeps Approve and Deny in browser mode, with no scope choice', () => {
    const h = view(waiting('Write', review), null)
    expect(h).toContain('Approve</button>')
    expect(h).toContain('Deny</button>')
    expect(h).not.toContain('Allow for')
    expect(h).not.toContain('permission rule')
  })

  it('offers the scope choice with a backend, for a write that has a review', () => {
    const h = view(waiting('Write', review), loaded())
    expect(h).toContain('<legend>Allow for</legend>')
    expect(h).toContain('Allow</button>')
    expect(h).toContain('Reject</button>')
    expect(h).not.toContain('Approve</button>')
  })

  it('holds Allow back until the full change is opened (it is closed on first render) but not Reject', () => {
    const h = view(waiting('Write', review), loaded())
    const allow = h.split('<button').find((b) => b.includes('</svg> Allow</button>'))!
    const reject = h.split('<button').find((b) => b.includes('</svg> Reject</button>'))!
    expect(allow).toContain('disabled')
    expect(reject).not.toContain('disabled')
  })

  it('offers Once only for a simulated approval with no digest', () => {
    const h = view(waiting('Write', null), loaded())
    expect(h.match(/type="radio"/g)).toHaveLength(1)
    expect(h).toContain('A simulated request can only be allowed once')
  })

  it('does not hold Allow back when there is no review to open', () => {
    const h = view(waiting('Bash', null), loaded())
    expect(h.split('<button').find((b) => b.includes('</svg> Allow</button>'))).not.toContain('disabled')
    expect(h).toContain('can only be allowed once')
  })

  it('shows the permission chip: the pending state, the count, none', () => {
    expect(view(waiting('Write', review), loaded())).toContain('Approval required</span>')
    expect(view(demo, loaded([{ id: 'p', scope: 'agent', effect: 'allow', tool: 'Read', agentId: agent.id, taskId: null, pathPattern: null, createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active' }]))).toContain('1 permission rule</span>')
    expect(view(demo, loaded())).toContain('No permission rules</span>')
    expect(view(demo, emptyPermissions())).not.toContain('permission rule')
  })
})

describe('TaskForm workspace choice', () => {
  const form = (workspaces: string[] | null) => renderToStaticMarkup(<TaskForm workspaces={workspaces} onStart={() => null}/>)
  it('offers No workspace and every registered id, with no workspace chosen by default', () => {
    const h = form(['sandbox', 'docs'])
    expect(h).toContain('<span>Workspace</span>')
    expect(h).toContain('<option value="" selected="">No workspace')
    expect(h).toContain('<option value="sandbox">sandbox</option>')
    expect(h).toContain('<option value="docs">docs</option>')
  })
  it('shows no choice in browser mode or when the backend has no workspace', () => {
    expect(form(null)).not.toContain('Workspace')
    expect(form([])).not.toContain('Workspace')
  })
  it('calls a task simulated only on the mock runtime', () => {
    const label = (real: boolean) => renderToStaticMarkup(<TaskForm workspaces={null} real={real} onStart={() => null}/>)
    expect(label(false)).toContain('Start simulated task')
    expect(label(true)).toContain('Start task')
    expect(label(true)).not.toContain('simulated')
  })
  it('names the task\'s workspace on its card', () => {
    const s = { ...demo, tasks: [{ ...waiting('Write', review).tasks[0], status: 'running' as const, pendingApproval: null, workspaceId: 'sandbox' }], agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'working' as const } : a)) }
    expect(view(s, loaded())).toContain('Workspace sandbox')
  })
})

describe('TaskForm runtime choice', () => {
  const both: RuntimeStatus[] = [{ kind: 'mock', available: true, reason: null }, { kind: 'claude', available: true, reason: null }]
  const form = (runtimes?: RuntimeStatus[], defaultRuntime: 'mock' | 'claude' = 'mock', workspaces: string[] | null = ['sandbox']) => renderToStaticMarkup(<TaskForm workspaces={workspaces} runtimes={runtimes} defaultRuntime={defaultRuntime} onStart={() => null}/>)
  it('shows no Runtime select with one runtime or an older server', () => {
    expect(form(undefined)).not.toContain('Runtime')
    expect(form([both[0]])).not.toContain('Runtime')
    expect(form([both[0]])).toContain('Start simulated task')
  })
  it('lists each runtime with the default selected and keeps the mock wording', () => {
    const h = form(both)
    expect(h).toContain('<span>Runtime</span>')
    expect(h).toContain('<option value="mock" selected="">Simulated (mock)</option>')
    expect(h).toContain('<option value="claude">Claude</option>')
    expect(h).toContain('Start simulated task')
    expect(h).not.toContain('The Claude agent works in the workspace')
  })
  it('selects Claude by default when it is the default: hint, Start task, workspace kept', () => {
    const h = form(both, 'claude')
    expect(h).toContain('<option value="claude" selected="">Claude</option>')
    expect(h).toContain('The Claude agent works in the workspace you choose and needs one.')
    expect(h).toContain('<span>Workspace</span>')
    expect(h).toContain('Start task')
    expect(h).not.toContain('Start simulated task')
  })
  it('does not offer the blank workspace for Claude: the first workspace is chosen, and the mock keeps the blank option', () => {
    const c = form(both, 'claude', ['sandbox', 'docs'])
    expect(c).not.toContain('No workspace')
    expect(c).toContain('<option value="sandbox" selected="">sandbox</option>')
    expect(form(both, 'mock', ['sandbox', 'docs'])).toContain('<option value="" selected="">No workspace')
  })
  it('disables Claude, with the reason, when no workspace is set up, and falls back to the mock', () => {
    for (const ws of [[], null]) {
      const h = form(both, 'claude', ws)
      expect(h).toContain('<option value="claude" disabled="">Claude (not available: no workspace is set up on the server)</option>')
      expect(h).toContain('<option value="mock" selected="">')
      expect(h).toContain('Start simulated task')
    }
  })
  it('says the reason is unknown when the server gave none', () => {
    expect(form([both[0], { kind: 'claude', available: false, reason: null }])).toContain('Claude (not available: reason unknown)')
  })
  it('disables an unavailable runtime and gives its reason', () => {
    const h = form([both[0], { kind: 'claude', available: false, reason: 'Claude Agent SDK not installed' }])
    expect(h).toContain('<option value="claude" disabled="">Claude (not available: Claude Agent SDK not installed)</option>')
  })
})

describe('demo controls', () => {
  const backend = (runtime: 'mock' | 'claude', defaultRuntime?: 'mock' | 'claude'): RuntimeEnvironment => ({ kind: 'backend', runtime, available: true, reason: null, ...(defaultRuntime ? { defaultRuntime } : {}) })
  it('are offered only when the server serves the demo routes: the default runtime is mock', () => {
    const s = (() => { const t = { ...demo, tasks: [{ ...waiting('Write', review).tasks[0], status: 'running' as const, pendingApproval: null, runtime: 'mock' as const }], agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'working' as const } : a)) }; return t })()
    expect(view(s, loaded(), backend('claude', 'claude'))).not.toContain('Demo controls')
    expect(view(s, loaded(), backend('mock', 'mock'))).toContain('Demo controls')
    expect(view(s, loaded(), backend('mock'))).toContain('Demo controls')
    expect(view(s, loaded(), { kind: 'backend', runtime: null, available: null, reason: null })).not.toContain('Demo controls')
    expect(view(s, null, { kind: 'browser' })).toContain('Demo controls')
  })

  const running = (runtime: 'mock' | 'claude') => ({ ...demo, tasks: [{ ...waiting('Write', review).tasks[0], status: 'running' as const, pendingApproval: null, runtime }], agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'working' as const } : a)) })
  it('are offered for a mock task and never for a Claude task', () => {
    expect(view(running('mock'), loaded())).toContain('Demo controls')
    expect(view(running('claude'), loaded())).not.toContain('Demo controls')
  })
})

describe('AgentDetail task usage', () => {
  const done = (usage: { turns: number; costUsd: number } | null) => ({
    ...demo,
    tasks: [{ ...demo.tasks[0], id: 'tk', agentId: agent.id, title: 'T', description: '', status: 'completed' as const, resultSummary: 'All done.', usage }],
    agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'idle' as const } : a)),
  })

  it('shows the steps and estimated cost under the result', () => {
    const h = view(done({ turns: 3, costUsd: 0.0123 }), null)
    expect(h).toContain('About $0.0123 (estimate) · 3 steps')
    expect(h.indexOf('All done.')).toBeLessThan(h.indexOf('About $0.0123'))
  })

  it('shows nothing about cost when there is no usage', () => {
    const h = view(done(null), null)
    expect(h).toContain('All done.')
    expect(h).not.toContain('(estimate)')
  })
})


describe('AgentDetail profile', () => {
  const profile = (patch: Partial<typeof agent>, extra: Partial<typeof demo> = {}, actions: Partial<WorkforceController> = {}) => {
    const state = { ...demo, ...extra, agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) }
    return renderToStaticMarkup(<AgentDetail workforce={{ state, permissions: null, actions } as unknown as Workforce} layout={layout} agent={state.agents.find((a) => a.id === agent.id)!} onBack={() => {}} onEdit={() => {}} onRemove={() => {}} onFocusDesk={() => {}}/>)
  }

  it('shows the description, instruction state and model', () => {
    const h = profile({ description: 'Plans the sprint', instructions: 'Be brief', model: 'claude-x' })
    expect(h).toContain('Plans the sprint')
    expect(h).toContain('Custom instructions set')
    expect(h).toContain('claude-x')
  })

  it('says so when there are no instructions and no model', () => {
    const h = profile({ description: '', instructions: '', model: null })
    expect(h).toContain('No custom instructions')
    expect(h).toContain('Server default')
  })

  const render = (state: typeof demo) => renderToStaticMarkup(<AgentDetail workforce={{ state, permissions: null, actions: {} as WorkforceController } as unknown as Workforce} layout={layout} agent={state.agents.find((a) => a.id === agent.id)!} onBack={() => {}} onEdit={() => {}} onRemove={() => {}} onFocusDesk={() => {}}/>)
  const assigned = () => {
    const r = assignTask(demo, agent.id, { title: 'T', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    return { state: markStarting(r.state, r.taskId, NOW), taskId: r.taskId }
  }

  it('offers Clear error after a task that failed through the real operations', () => {
    const { state, taskId } = assigned()
    const running = applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'e1' }, NOW, 'mock')
    expect(render(running)).not.toContain('Clear error')
    const failed = applyRuntimeEvent(running, { type: 'failed', taskId, error: 'boom' }, NOW, 'mock')
    expect(failed.agents.find((a) => a.id === agent.id)!.status).toBe('error')
    expect(render(failed)).toContain('Clear error</button>')
  })

  it('offers Clear error after a run interrupted by a reload', () => {
    const { state, taskId } = assigned()
    const running = applyRuntimeEvent(state, { type: 'started', taskId, executionId: 'e1' }, NOW, 'mock')
    const recovered = recoverInterruptedTasks(running, NOW)
    expect(recovered.agents.find((a) => a.id === agent.id)!.status).toBe('error')
    expect(render(recovered)).toContain('Clear error</button>')
  })

  it('does not offer Clear error for an idle agent', () => {
    expect(render(demo)).not.toContain('Clear error')
  })

  it('treats blank instructions and description as empty', () => {
    const h = profile({ description: '   ', instructions: '  \n ' })
    expect(h).toContain('No custom instructions')
    expect(h).not.toContain('Custom instructions set')
  })
})

describe('AgentDetail import source', () => {
  it('names the file an imported agent came from, without the workspace id', () => {
    const state = { ...demo, agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, sourceFile: 'sandbox:backend-engineer.md' } : a)) }
    const h = view(state, null)
    expect(h).toContain('Imported from backend-engineer.md')
    expect(h).not.toContain('sandbox:backend')
  })

  it('says nothing for an agent that was not imported', () => {
    expect(view(demo, null)).not.toContain('Imported from')
  })
})

describe('AgentDetail today', () => {
  it('shows the day in Jakarta time with the exact approximation line when prayer breaks are on', () => {
    const h = view({ ...demo, agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, takesPrayerBreaks: true } : a)) }, null)
    expect(h).toContain('Today')
    expect(h).toContain('Jakarta time')
    expect(h).toContain('Praying')
    expect(h).toContain('Prayer times are approximate; follow your official schedule.')
  })
  it('leaves the approximation line and prayers out when prayer breaks are off', () => {
    const h = view({ ...demo, agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, takesPrayerBreaks: false } : a)) }, null)
    expect(h).toContain('On lunch')
    expect(h).not.toContain('Praying')
    expect(h).not.toContain('Prayer times are approximate')
  })

  it('lists the day of the office clock, not of the browser clock', () => {
    const prayerOn = { ...demo, agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, takesPrayerBreaks: true } : a)) }
    const at = (iso: string) => createOfficeClock({ nowMs: Date.parse(iso), speed: 1, routine: true }, () => 0)
    const withClock = (iso: string) => renderToStaticMarkup(<OfficeClockContext.Provider value={at(iso)}><AgentDetail workforce={{ state: prayerOn, permissions: null, actions: {} as WorkforceController } as unknown as Workforce} layout={layout} agent={prayerOn.agents.find((a) => a.id === agent.id)!} onBack={() => {}} onEdit={() => {}} onRemove={() => {}} onFocusDesk={() => {}}/></OfficeClockContext.Provider>)
    expect(withClock('2026-11-13T09:00:00+07:00')).toContain('Friday prayer and lunch')
    expect(withClock('2026-11-09T09:00:00+07:00')).not.toContain('Friday prayer and lunch')
  })
})

describe('AgentDetail held task', () => {
  const HOLD: TaskHold = { label: 'On lunch', untilMs: Date.parse('2026-11-09T13:00:00+07:00'), blockedBy: null }
  const heldState = (hold = HOLD) => {
    const r = assignTask(demo, agent.id, { title: 'Write notes', description: '' }, NOW, { hold })
    if (!r.ok) throw new Error(r.error)
    return r.state
  }

  it('shows the waiting text in a status region with Start now beside Cancel task', () => {
    const h = view(heldState(), null)
    expect(h).toContain('role="status"')
    expect(h).toContain('On lunch · starts around 13:00')
    expect(h).toContain('Start now</button>')
    expect(h).toContain('Cancel task</button>')
  })
  it('shows why it still waits when blocked', () => {
    expect(view(heldState({ ...HOLD, blockedBy: 'Waiting for a free Claude slot. It starts as soon as one finishes.' }), null)).toContain('Waiting for a free Claude slot. It starts as soon as one finishes.')
  })
  it('offers Clear error when the agent is in error and its task is only held', () => {
    const s = heldState()
    const errored = { ...s, agents: s.agents.map((a) => (a.id === agent.id ? { ...a, status: 'error' as const } : a)) }
    expect(view(errored, null)).toContain('Clear error</button>')
    expect(view(heldState(), null)).not.toContain('Clear error</button>')
  })
  it('an unheld running task has no Start now', () => {
    const r = assignTask(demo, agent.id, { title: 'Write notes', description: '' }, NOW)
    if (!r.ok) throw new Error(r.error)
    const running = applyRuntimeEvent(markStarting(r.state, r.taskId, NOW), { type: 'started', taskId: r.taskId, executionId: 'e' }, NOW, 'mock')
    const h = view(running, null)
    expect(h).not.toContain('Start now')
    expect(h).toContain('Cancel task</button>')
  })
  it('the Start now handler asks for exactly that task and returns the refusal text', async () => {
    const calls: string[] = []
    const actions = { startHeldTask: (id: string) => { calls.push(id); return { ok: false as const, error: 'A Claude task is already running, which is the limit. Wait for one to finish.' } } } as unknown as WorkforceController
    expect(await startHeldNow(actions, 'tk')).toBe('A Claude task is already running, which is the limit. Wait for one to finish.')
    expect(calls).toEqual(['tk'])
    expect(await startHeldNow({ startHeldTask: () => ({ ok: true }) } as unknown as WorkforceController, 'tk')).toBeNull()
  })
})
