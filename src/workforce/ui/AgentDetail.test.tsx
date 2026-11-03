import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../layout/defaultLayout'
import type { PermissionRuleView } from '../api'
import type { WorkforceController } from '../controller'
import { createDemoWorkforce } from '../demo'
import { emptyPermissions, withLists, type PermissionsState } from '../permissions'
import type { ToolReview } from '../types'
import type { Workforce } from '../useWorkforce'
import AgentDetail from './AgentDetail'

const NOW = '2026-11-03T09:00:00.000Z'
const layout = createDefaultLayout()
const demo = createDemoWorkforce(NOW)
const agent = demo.agents[0]
const review: ToolReview = { kind: 'write', path: 'src/a.ts', bytes: 3, lines: 1, content: 'abc', workspaceId: 'sandbox', digest: 'ab'.repeat(32) }

const waiting = (tool: string, withReview: ToolReview | null): typeof demo => ({
  ...demo,
  tasks: [{ ...(demo.tasks[0] ?? ({} as never)), id: 'tk', agentId: agent.id, title: 'T', description: '', status: 'waiting_for_approval' as const, pendingApproval: { id: 'ap1', tool, summary: `${tool} src/a.ts`, requestedAt: NOW, digest: withReview?.digest ?? null, review: withReview } }],
  agents: demo.agents.map((a) => (a.id === agent.id ? { ...a, currentTaskId: 'tk', status: 'waiting' as const } : a)),
})

const view = (state: typeof demo, permissions: PermissionsState | null) =>
  renderToStaticMarkup(<AgentDetail workforce={{ state, permissions, actions: {} as WorkforceController } as unknown as Workforce} layout={layout} agent={state.agents.find((a) => a.id === agent.id)!} onBack={() => {}} onEdit={() => {}} onRemove={() => {}} onFocusDesk={() => {}}/>)

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
