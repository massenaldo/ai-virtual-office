import type { DialogRequest } from '../../editor/useEditorActions'
import type { OfficeLayout } from '../../layout/types'
import type { Workforce } from '../useWorkforce'
import { deskLabel, removalPrompt } from '../view'
import AgentDetail from './AgentDetail'
import AgentForm from './AgentForm'
import AgentList from './AgentList'
import AssignDesk from './AssignDesk'

export type WorkforceView = { kind: 'list' } | { kind: 'create' } | { kind: 'detail' | 'edit'; agentId: string } | { kind: 'assign'; deskId: string }

export type WorkforcePanelProps = { workforce: Workforce | null; layout: OfficeLayout; view: WorkforceView; onViewChange(v: WorkforceView): void; onFocusDesk(deskId: string): void; openDialog(d: DialogRequest): void }

/** The agent the panel is showing, if any; the office highlights its desk. */
export function selectedAgentId(view: WorkforceView): string | null {
  return view.kind === 'detail' || view.kind === 'edit' ? view.agentId : null
}

export default function WorkforcePanel({ workforce, layout, view, onViewChange: setView, onFocusDesk, openDialog }: WorkforcePanelProps) {
  const header = <div className="panel-title">AI agents <span className="mock-badge" title="Tasks are simulated in the browser. No AI is run.">Mock mode</span></div>
  if (!workforce) return <aside className="editor-panel workforce" aria-label="AI agents">{header}<p className="panel-hint">Loading agents…</p></aside>

  const { state, actions } = workforce
  const agentId = selectedAgentId(view)
  const agent = agentId ? state.agents.find((a) => a.id === agentId) : undefined
  const assignDesk = view.kind === 'assign' ? layout.furniture.find((f) => f.id === view.deskId && f.type === 'desk') : undefined
  // A removed agent or a desk that left the layout falls back to the list.
  const shown: WorkforceView = (agentId && !agent) || (view.kind === 'assign' && !assignDesk) ? { kind: 'list' } : view
  const list = () => setView({ kind: 'list' })

  const remove = (id: string) => {
    const prompt = removalPrompt(state, id)
    const run = () => { actions.removeAgent(id); list() }
    if (!prompt) return run()
    openDialog({ ...prompt, actions: [{ label: 'Remove agent', tone: 'danger', onClick: run }] })
  }

  return <aside className="editor-panel workforce" aria-label="AI agents">
    {header}
    {shown.kind === 'list' && <AgentList state={state} layout={layout} onOpen={(id) => setView({ kind: 'detail', agentId: id })} onCreate={() => setView({ kind: 'create' })} onRestoreDemo={actions.restoreDemoAgents}/>}
    {shown.kind === 'create' && <>
      <div className="field-group-label">New agent</div>
      <AgentForm onCancel={list} onSubmit={async (input) => {
        const r = await actions.createAgent(input)
        if (!r.ok) return r.error
        setView({ kind: 'detail', agentId: r.id })
        return null
      }}/>
    </>}
    {shown.kind === 'edit' && agent && <>
      <div className="field-group-label">Edit {agent.name}</div>
      <AgentForm agent={agent} onCancel={() => setView({ kind: 'detail', agentId: agent.id })} onSubmit={async (input) => {
        const r = await actions.updateAgent(agent.id, input)
        if (!r.ok) return r.error
        setView({ kind: 'detail', agentId: agent.id })
        return null
      }}/>
    </>}
    {shown.kind === 'detail' && agent && <AgentDetail key={agent.id} workforce={workforce} layout={layout} agent={agent} onBack={list} onEdit={() => setView({ kind: 'edit', agentId: agent.id })} onRemove={() => remove(agent.id)} onFocusDesk={() => agent.deskId && onFocusDesk(agent.deskId)}/>}
    {shown.kind === 'assign' && assignDesk && <AssignDesk key={assignDesk.id} state={state} layout={layout} deskId={assignDesk.id} deskLabel={deskLabel(assignDesk.id)} onCancel={list} onAssign={async (id) => {
      const r = await actions.assignDesk(id, assignDesk.id)
      if (!r.ok) return r.error
      setView({ kind: 'detail', agentId: id })
      return null
    }}/>}
  </aside>
}
