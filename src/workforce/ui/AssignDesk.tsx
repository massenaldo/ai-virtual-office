import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { DEPARTMENTS } from '../../layout/catalog'
import type { OfficeLayout } from '../../layout/types'
import type { WorkforceState } from '../types'
import { assignableAgents, deskStatus } from '../view'
import { StatusDot } from './AgentList'

export type AssignDeskProps = { state: WorkforceState; layout: OfficeLayout; deskId: string; deskLabel: string; onAssign(agentId: string): string | null; onCancel(): void }

/** Pick an agent for a free desk clicked in the office. onAssign returns an error message, or null when it was applied. */
export default function AssignDesk({ state, layout, deskLabel, onAssign, onCancel }: AssignDeskProps) {
  const [error, setError] = useState<string | null>(null)
  const agents = assignableAgents(state)
  return <>
    <button className="panel-link" onClick={onCancel}><ArrowLeft size={13}/> All agents</button>
    <div className="field-group-label">Assign {deskLabel}</div>
    {agents.length === 0 ? <p className="panel-hint">No agents yet. Create one first.</p> : <>
      <p className="panel-hint">Pick an agent for this desk. An agent that already has a desk moves here.</p>
      <ul className="agent-list">{agents.map((a) => {
        const desk = deskStatus(layout, a)
        return <li key={a.id}><button className="agent-row" onClick={() => setError(onAssign(a.id))}>
          <StatusDot status={a.status}/>
          <span className="agent-row-main"><strong>{a.name}</strong><small>{a.role} · {DEPARTMENTS[a.department].label}</small>
            <span className="agent-chips"><span className={desk.kind === 'unavailable' ? 'agent-chip warning' : 'agent-chip'}>{desk.kind === 'assigned' ? `Now at ${desk.label}` : desk.kind === 'unavailable' ? 'Desk unavailable' : 'No desk'}</span></span></span>
        </button></li>
      })}</ul>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>
}
