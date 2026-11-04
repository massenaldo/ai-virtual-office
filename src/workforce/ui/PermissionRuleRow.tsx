import { Ban, Check, Clock, Hourglass, ShieldCheck, ShieldQuestion, ShieldX, type LucideIcon } from 'lucide-react'
import type { PermissionRuleView } from '../api'
import { PERMISSION_SCOPE_LABEL, permissionStateText, type PermissionIcon } from '../view'

const ICONS: Record<PermissionIcon, LucideIcon> = { allowed: ShieldCheck, denied: ShieldX, ask: ShieldQuestion, expired: Clock, revoked: Ban, used: Check, ended: Hourglass }

const when = (iso: string): string => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * One permission rule. Every field is rendered as React text, so a reason or path pattern that looks like markup stays text.
 * `onRevoke` is absent for a rule that is no longer active.
 */
export default function PermissionRuleRow({ rule, agentName, onRevoke }: { rule: PermissionRuleView; agentName: string | null; onRevoke?(): void }) {
  const state = permissionStateText(rule)
  const Icon = ICONS[state.icon]
  const ended = rule.revokedAt ?? rule.usedAt ?? rule.endedAt
  return <li className={`permission-row ${rule.state === 'active' ? rule.effect : 'inactive'}`}>
    <div className="permission-row-head">
      <strong>{rule.tool}</strong>
      <span className={`agent-chip permission-state ${state.icon}`}><Icon size={10} aria-hidden="true"/> {state.label}</span>
    </div>
    <dl className="permission-facts">
      <div><dt>Covers</dt><dd>{PERMISSION_SCOPE_LABEL[rule.scope]}{agentName && rule.scope !== 'global' ? ` · ${agentName}` : ''}</dd></div>
      {rule.workspaceId && <div><dt>Workspace</dt><dd>{rule.workspaceId}</dd></div>}
      {rule.runtime && <div><dt>Runtime</dt><dd>{rule.runtime === 'mock' ? 'Mock tasks' : 'Claude tasks'}</dd></div>}
      {rule.pathPattern && <div><dt>Paths</dt><dd>{rule.pathPattern}</dd></div>}
      <div><dt>Created</dt><dd>{when(rule.createdAt)} · {rule.createdBy === 'default' ? 'built-in default' : rule.createdBy === 'user' ? 'by you' : 'by the system'}</dd></div>
      {rule.expiresAt && <div><dt>Expires</dt><dd>{when(rule.expiresAt)}</dd></div>}
      {ended && rule.state !== 'active' && <div><dt>Ended</dt><dd>{when(ended)}</dd></div>}
      {rule.reason && <div><dt>Reason</dt><dd>{rule.reason}</dd></div>}
    </dl>
    {onRevoke && <button type="button" className="panel-button danger" onClick={onRevoke} aria-label={`Revoke ${rule.tool} ${PERMISSION_SCOPE_LABEL[rule.scope].toLowerCase()}${rule.pathPattern ? ` on ${rule.pathPattern}` : ''}${rule.workspaceId ? ` in workspace ${rule.workspaceId}` : ''}`}><Ban size={13}/> Revoke</button>}
  </li>
}
