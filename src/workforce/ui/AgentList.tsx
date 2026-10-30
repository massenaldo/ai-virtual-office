import { useState } from 'react'
import { Plus, RotateCcw } from 'lucide-react'
import { DEPARTMENTS } from '../../layout/catalog'
import type { OfficeLayout } from '../../layout/types'
import { DEMO_AGENTS } from '../demo'
import type { Agent, AgentStatus, WorkforceState } from '../types'
import { AGENT_DEPARTMENTS, AGENT_STATUS_LABEL, deskStatus, filterAgents, type AgentFilter } from '../view'

export type AgentListProps = { state: WorkforceState; layout: OfficeLayout; onOpen(id: string): void; onCreate(): void; onRestoreDemo(): void }

const STATUSES = Object.keys(AGENT_STATUS_LABEL) as AgentStatus[]

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={`agent-status-dot ${status}`} aria-hidden="true"/>
}

function DeskChip({ layout, agent }: { layout: OfficeLayout; agent: Agent }) {
  const desk = deskStatus(layout, agent)
  if (desk.kind === 'assigned') return <span className="agent-chip">{desk.label}</span>
  return <span className={desk.kind === 'unavailable' ? 'agent-chip warning' : 'agent-chip'}>{desk.kind === 'unavailable' ? 'Desk unavailable' : 'No desk'}</span>
}

export default function AgentList({ state, layout, onOpen, onCreate, onRestoreDemo }: AgentListProps) {
  const [filter, setFilter] = useState<AgentFilter>({ department: 'all', status: 'all' })
  const agents = filterAgents(state.agents, filter)
  const demoMissing = DEMO_AGENTS.some((d) => !state.agents.some((a) => a.id === d.id))

  return <>
    <div className="field-row">
      <label className="field"><span>Department</span>
        <select className="field-input" value={filter.department} onChange={(e) => setFilter({ ...filter, department: e.target.value as AgentFilter['department'] })}>
          <option value="all">All departments</option>
          {AGENT_DEPARTMENTS.map((id) => <option key={id} value={id}>{DEPARTMENTS[id].label}</option>)}
        </select>
      </label>
      <label className="field"><span>Status</span>
        <select className="field-input" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as AgentFilter['status'] })}>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{AGENT_STATUS_LABEL[s]}</option>)}
        </select>
      </label>
    </div>
    {state.agents.length === 0
      ? <p className="panel-hint">No agents yet. Create one or restore the demo agents.</p>
      : agents.length === 0
        ? <p className="panel-hint">No agents match these filters.</p>
        : <ul className="agent-list">{agents.map((a) => <li key={a.id}>
          <button className="agent-row" onClick={() => onOpen(a.id)}>
            <StatusDot status={a.status}/>
            <span className="agent-row-main"><strong>{a.name}</strong><small>{a.role} · {DEPARTMENTS[a.department].label}</small>
              <span className="agent-chips">{a.demo && <span className="agent-chip demo">Demo</span>}<DeskChip layout={layout} agent={a}/></span></span>
            <span className="agent-row-status">{AGENT_STATUS_LABEL[a.status]}</span>
          </button>
        </li>)}</ul>}
    <div className="panel-actions">
      <button className="panel-button primary" onClick={onCreate}><Plus size={13}/> New agent</button>
      {demoMissing && <button className="panel-button" onClick={onRestoreDemo}><RotateCcw size={13}/> Restore demo agents</button>}
    </div>
  </>
}
