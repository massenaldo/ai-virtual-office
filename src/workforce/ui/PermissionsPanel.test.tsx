import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PermissionRuleView } from '../api'
import { createDemoWorkforce } from '../demo'
import { emptyPermissions, withLists, type PermissionsState } from '../permissions'
import PermissionsPanel, { PermissionsBody } from './PermissionsPanel'
import WorkforcePanel, { type WorkforceView } from './WorkforcePanel'

const NOW = '2026-11-03T09:00:00.000Z'
const demo = createDemoWorkforce(NOW)
const agent = demo.agents[0]
const rule = (id: string, over: Partial<PermissionRuleView> = {}): PermissionRuleView => ({ id, scope: 'global', effect: 'allow', tool: 'Read', agentId: null, taskId: null, pathPattern: null, createdAt: NOW, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, state: 'active', ...over })

const body = (permissions: PermissionsState, tab = 'global', error: string | null = null, state = demo) =>
  renderToStaticMarkup(<PermissionsBody state={state} permissions={permissions} tab={tab} onTab={() => {}} onOpenAgent={() => {}} onRevoke={() => {}} onRevokeAll={() => {}} error={error}/>)

describe('PermissionsBody', () => {
  it('shows a loading note until the first load completes, and no empty-list claim', () => {
    const html = body(emptyPermissions())
    expect(html).toContain('Loading permissions')
    expect(html).not.toContain('No global rules')
    expect(html).not.toContain('Nothing has ended yet')
  })

  it('shows the server error as an alert', () => {
    expect(body(emptyPermissions(), 'global', 'No permissions today.')).toContain('role="alert">No permissions today.')
  })

  it('says so when a loaded tab is empty', () => {
    const html = body(withLists(emptyPermissions(), [], []))
    expect(html).toContain('No global rules')
    expect(html).toContain('Nothing has ended yet')
  })

  it('has a Global tab and one per agent, with the selected one marked', () => {
    const html = body(withLists(emptyPermissions(), [], []), agent.id)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('>Global</button>')
    for (const a of demo.agents) expect(html).toContain(`>${a.name}</button>`)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toMatch(new RegExp(`id="perm-tab-${agent.id}"[^>]*aria-selected="true"`))
    expect(html).toContain(`aria-labelledby="perm-tab-${agent.id}"`)
  })

  it('only the selected tab is in the tab order', () => {
    const html = body(withLists(emptyPermissions(), [], []))
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(demo.agents.length)
  })

  it('filters rules by tab', () => {
    const p = withLists(emptyPermissions(), [rule('g', { tool: 'Edit' }), rule('a', { scope: 'agent', agentId: agent.id, tool: 'Grep' })], [])
    expect(body(p)).toContain('Edit')
    expect(body(p)).not.toContain('Grep')
    expect(body(p, agent.id)).toContain('Grep')
    expect(body(p, agent.id)).not.toContain('Edit')
  })

  it('states every rule in words, with an icon', () => {
    const p = withLists(emptyPermissions(), [rule('a', { effect: 'allow' }), rule('d', { effect: 'deny', tool: 'Bash' }), rule('k', { effect: 'ask', tool: 'Write' })], [rule('r', { state: 'revoked', revokedAt: NOW }), rule('e', { state: 'expired' }), rule('u', { state: 'used', usedAt: NOW }), rule('n', { state: 'ended', endedAt: NOW })])
    const html = body(p)
    for (const word of ['Allowed', 'Denied', 'Approval required', 'Revoked', 'Expired', 'Used', 'Ended']) expect(html).toContain(word)
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)!.length).toBeGreaterThanOrEqual(7)
  })

  it('offers Revoke on active rules only, with a name that says which rule', () => {
    const p = withLists(emptyPermissions(), [rule('a', { tool: 'Write', pathPattern: 'src/**' })], [rule('h', { state: 'revoked', tool: 'Edit' })])
    const html = body(p)
    expect(html.match(/aria-label="Revoke /g)).toHaveLength(1)
    expect(html).toContain('aria-label="Revoke Write all agents on src/**"')
  })

  it('shows rule text as text, never as markup', () => {
    const p = withLists(emptyPermissions(), [rule('x', { reason: '<img src=x onerror=alert(1)>', pathPattern: '<script>1</script>', tool: '<b>T</b>' })], [])
    const html = body(p)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>T')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('offers Revoke all only on an agent tab that has active rules', () => {
    const p = withLists(emptyPermissions(), [rule('a', { scope: 'agent', agentId: agent.id }), rule('g')], [])
    expect(body(p)).not.toContain('Revoke all')
    expect(body(p, agent.id)).toContain(`Revoke all for ${agent.name}`)
    expect(body(withLists(emptyPermissions(), [], []), agent.id)).not.toContain('Revoke all')
  })

  it('lists a task that is waiting for a decision, on the global tab and on its agent tab', () => {
    const waiting = { ...demo, tasks: [{ ...(demo.tasks[0] ?? ({} as never)), id: 'tk', agentId: agent.id, status: 'waiting_for_approval' as const, pendingApproval: { id: 'ap', tool: 'Write', summary: 'Write src/a.ts', requestedAt: NOW, digest: null, review: null, onceOnly: false } }] }
    const p = withLists(emptyPermissions(), [], [])
    for (const tab of ['global', agent.id]) expect(body(p, tab, null, waiting)).toContain('Pending')
    expect(body(p, demo.agents[1].id, null, waiting)).not.toContain('Pending')
  })
})

describe('PermissionsPanel', () => {
  it('has a way back to the agent list', () => {
    const html = renderToStaticMarkup(<PermissionsPanel state={demo} permissions={withLists(emptyPermissions(), [], [])} tab="global" onTab={() => {}} onBack={() => {}} onOpenAgent={() => {}} actions={{}} openDialog={() => {}}/>)
    expect(html).toContain('All agents')
    expect(html).toContain('>Permissions<')
  })
})

describe('WorkforcePanel permissions view', () => {
  const layout = { furniture: [] } as never
  const workforce = (permissions: PermissionsState | null) => ({
    state: demo, loadProblem: null, preserved: null, saveError: null, environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'live', lastSyncedAt: NOW,
    commandError: null, connectionError: null, needsPairing: false, pairingNote: null, permissions, actions: {},
  }) as never
  const render = (permissions: PermissionsState | null, view: WorkforceView) => renderToStaticMarkup(<WorkforcePanel workforce={workforce(permissions)} layout={layout} view={view} onViewChange={() => {}} onFocusDesk={() => {}} openDialog={() => {}}/>)

  it('the agent list links to the permissions with the number of active rules', () => {
    expect(render(withLists(emptyPermissions(), [rule('a'), rule('b')], []), { kind: 'list' })).toContain('Permissions (2 active)')
  })

  it('without a backend the view explains itself and makes no promise of rules', () => {
    const html = render(null, { kind: 'permissions', tab: 'global' })
    expect(html).toContain('local backend')
    expect(html).not.toContain('role="tablist"')
  })

  it('a tab for an agent that no longer exists falls back to Global', () => {
    const html = render(withLists(emptyPermissions(), [], []), { kind: 'permissions', tab: 'gone' })
    expect(html).toMatch(/id="perm-tab-global"[^>]*aria-selected="true"/)
  })
})
