import { useState } from 'react'
import type { DialogRequest } from '../../editor/useEditorActions'
import type { OfficeLayout } from '../../layout/types'
import type { Workforce } from '../useWorkforce'
import { removalPrompt } from '../view'
import AgentDetail from './AgentDetail'
import AgentForm from './AgentForm'
import AgentList from './AgentList'

export type WorkforcePanelProps = { workforce: Workforce | null; layout: OfficeLayout; openDialog(d: DialogRequest): void }

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail' | 'edit'; agentId: string }

export default function WorkforcePanel({ workforce, layout, openDialog }: WorkforcePanelProps) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const header = <div className="panel-title">AI agents <span className="mock-badge" title="Tasks are simulated in the browser. No AI is run.">Mock mode</span></div>
  if (!workforce) return <aside className="editor-panel workforce" aria-label="AI agents">{header}<p className="panel-hint">Loading agents…</p></aside>

  const { state, actions } = workforce
  const agent = view.kind === 'detail' || view.kind === 'edit' ? state.agents.find((a) => a.id === view.agentId) : undefined
  // A removed agent (from another view or a restore) falls back to the list.
  const shown: View = (view.kind === 'detail' || view.kind === 'edit') && !agent ? { kind: 'list' } : view
  const list = () => setView({ kind: 'list' })

  const remove = (id: string) => {
    const prompt = removalPrompt(state, id)
    const run = () => { actions.removeAgent(id); list() }
    if (!prompt) return run()
    openDialog({ ...prompt, actions: [{ label: 'Remove agent', tone: 'danger', onClick: run }] })
  }

  return <aside className="editor-panel workforce" aria-label="AI agents">
    {header}
    {shown.kind === 'list' && <AgentList state={state} layout={layout} onOpen={(agentId) => setView({ kind: 'detail', agentId })} onCreate={() => setView({ kind: 'create' })} onRestoreDemo={actions.restoreDemoAgents}/>}
    {shown.kind === 'create' && <>
      <div className="field-group-label">New agent</div>
      <AgentForm onCancel={list} onSubmit={(input) => {
        const r = actions.createAgent(input)
        if (!r.ok) return r.error
        setView({ kind: 'detail', agentId: r.id })
        return null
      }}/>
    </>}
    {shown.kind === 'edit' && agent && <>
      <div className="field-group-label">Edit {agent.name}</div>
      <AgentForm agent={agent} onCancel={() => setView({ kind: 'detail', agentId: agent.id })} onSubmit={(input) => {
        const r = actions.updateAgent(agent.id, input)
        if (!r.ok) return r.error
        setView({ kind: 'detail', agentId: agent.id })
        return null
      }}/>
    </>}
    {shown.kind === 'detail' && agent && <AgentDetail key={agent.id} workforce={workforce} layout={layout} agent={agent} onBack={list} onEdit={() => setView({ kind: 'edit', agentId: agent.id })} onRemove={() => remove(agent.id)}/>}
  </aside>
}
