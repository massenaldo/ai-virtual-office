import { useState } from 'react'
import { ArrowLeft, ShieldQuestion } from 'lucide-react'
import type { DialogRequest } from '../../editor/useEditorActions'
import type { PermissionRuleView } from '../api'
import type { ActionResult, WorkforceController } from '../controller'
import type { PermissionsState } from '../permissions'
import type { WorkforceState } from '../types'
import { revokeAgentPrompt, revokePrompt, rulesForTab, waitingApprovals } from '../view'
import PermissionRuleRow from './PermissionRuleRow'

export type PermissionsPanelProps = {
  state: WorkforceState
  permissions: PermissionsState
  /** 'global' or an agent id. */
  tab: string
  onTab(tab: string): void
  onBack(): void
  onOpenAgent(agentId: string): void
  actions: Pick<WorkforceController, 'revokePermission' | 'revokeAgentPermissions'>
  openDialog(d: DialogRequest): void
}

/** The lists and tabs, without any state of their own, so every case can be shown from props. */
export function PermissionsBody({ state, permissions, tab, onTab, onOpenAgent, onRevoke, onRevokeAll, error }: Omit<PermissionsPanelProps, 'actions' | 'openDialog' | 'onBack'> & { onRevoke(rule: PermissionRuleView): void; onRevokeAll(): void; error: string | null }) {
  const agent = state.agents.find((a) => a.id === tab)
  const nameOf = (id: string | null) => state.agents.find((a) => a.id === id)?.name ?? null
  const active = rulesForTab(permissions.active, tab)
  const history = rulesForTab(permissions.history, tab)
  const waiting = waitingApprovals(state).filter((w) => tab === 'global' || w.agentId === tab)
  const tabs = [{ id: 'global', label: 'Global' }, ...state.agents.map((a) => ({ id: a.id, label: a.name }))]
  return <>
    <div className="permission-tabs" role="tablist" aria-label="Permissions for">
      {tabs.map((t) => <button key={t.id} type="button" role="tab" id={`perm-tab-${t.id}`} aria-selected={t.id === tab} aria-controls="perm-tabpanel" tabIndex={t.id === tab ? 0 : -1} className={t.id === tab ? 'permission-tab selected' : 'permission-tab'} onClick={() => onTab(t.id)}>{t.label}</button>)}
    </div>
    <div role="tabpanel" id="perm-tabpanel" aria-labelledby={`perm-tab-${tab}`}>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!permissions.loaded && !error && <p className="panel-hint" role="status">Loading permissions…</p>}
      {waiting.length > 0 && <>
        <div className="field-group-label section">Waiting for a decision</div>
        <ul className="permission-list">{waiting.map((w) => <li key={w.taskId} className="permission-row ask">
          <div className="permission-row-head"><strong>{w.tool}</strong><span className="agent-chip permission-state ask"><ShieldQuestion size={10} aria-hidden="true"/> Pending</span></div>
          <p className="panel-hint">{w.agentName}: {w.summary}</p>
          <button type="button" className="panel-link" onClick={() => onOpenAgent(w.agentId)}>Review in {w.agentName}'s detail</button>
        </li>)}</ul>
      </>}
      <div className="field-group-label section">Active</div>
      {permissions.loaded && active.length === 0 && <p className="panel-hint">{tab === 'global' ? 'No global rules. Everything not allowed by an agent or task grant is denied.' : `No rules for ${agent?.name ?? 'this agent'}.`}</p>}
      {active.length > 0 && <ul className="permission-list">{active.map((r) => <PermissionRuleRow key={r.id} rule={r} agentName={nameOf(r.agentId)} onRevoke={() => onRevoke(r)}/>)}</ul>}
      {agent && active.length > 0 && <div className="panel-actions"><button type="button" className="panel-button danger" onClick={onRevokeAll}>Revoke all for {agent.name}</button></div>}
      <div className="field-group-label section">History</div>
      {permissions.loaded && history.length === 0 && <p className="panel-hint">Nothing has ended yet.</p>}
      {history.length > 0 && <ul className="permission-list">{history.map((r) => <PermissionRuleRow key={r.id} rule={r} agentName={nameOf(r.agentId)}/>)}</ul>}
    </div>
  </>
}

export default function PermissionsPanel({ state, permissions, tab, onTab, onBack, onOpenAgent, actions, openDialog }: PermissionsPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const settle = (r: ActionResult | undefined) => setError(r && !r.ok ? r.error : null)
  const revoke = (rule: PermissionRuleView) => {
    const name = state.agents.find((a) => a.id === rule.agentId)?.name ?? null
    openDialog({ ...revokePrompt(rule, name), actions: [{ label: 'Revoke', tone: 'danger', onClick: () => { void Promise.resolve(actions.revokePermission?.(rule.id)).then(settle) } }] })
  }
  const agent = state.agents.find((a) => a.id === tab)
  const revokeAll = () => {
    if (!agent) return
    const count = rulesForTab(permissions.active, agent.id).length
    openDialog({ ...revokeAgentPrompt(agent.name, count), actions: [{ label: 'Revoke all', tone: 'danger', onClick: () => { void Promise.resolve(actions.revokeAgentPermissions?.(agent.id)).then(settle) } }] })
  }
  return <>
    <button className="panel-link" onClick={onBack}><ArrowLeft size={13}/> All agents</button>
    <div className="field-group-label">Permissions</div>
    <PermissionsBody state={state} permissions={permissions} tab={tab} onTab={(t) => { setError(null); onTab(t) }} onOpenAgent={onOpenAgent} onRevoke={revoke} onRevokeAll={revokeAll} error={error ?? permissions.error}/>
  </>
}
