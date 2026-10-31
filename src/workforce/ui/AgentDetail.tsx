import { useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowLeft, Check, LocateFixed, OctagonX, Pencil, Play, ShieldQuestion, Square, Trash2, X } from 'lucide-react'
import { DEPARTMENTS } from '../../layout/catalog'
import type { OfficeLayout } from '../../layout/types'
import type { Workforce } from '../useWorkforce'
import type { Awaitable } from '../controller'
import { useBusy } from './useBusy'
import { DESCRIPTION_MAX, TITLE_MAX, isActiveTask, type TaskInput } from '../operations'
import type { Agent } from '../types'
import { TASK_RUNTIME_LABEL, TASK_STATUS_LABEL, agentStatusText, agentTimeline, deskOptions, deskStatus, formatTime } from '../view'
import { StatusDot } from './AgentList'

export type AgentDetailProps = { workforce: Workforce; layout: OfficeLayout; agent: Agent; onBack(): void; onEdit(): void; onRemove(): void; onFocusDesk(): void }

function TaskForm({ onStart }: { onStart(input: TaskInput): Awaitable<string | null> }) {
  const [input, setInput] = useState<TaskInput>({ title: '', description: '' })
  const [error, setError] = useState<string | null>(null)
  const { busy, run } = useBusy()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const result = await run(() => onStart(input))
    if (result === undefined) return
    setError(result)
    if (result === null) setInput({ title: '', description: '' })
  }
  return <form onSubmit={submit} noValidate>
    <label className="field"><span>Title</span><input className="field-input" value={input.title} maxLength={TITLE_MAX} placeholder="e.g. Draft the sprint plan" onChange={(e) => setInput({ ...input, title: e.target.value })}/></label>
    <label className="field"><span>Description</span><textarea className="field-input" rows={3} value={input.description} maxLength={DESCRIPTION_MAX} onChange={(e) => setInput({ ...input, description: e.target.value })}/></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="panel-actions"><button type="submit" className="panel-button primary" disabled={busy}><Play size={13}/> Start simulated task</button></div>
  </form>
}

export default function AgentDetail({ workforce, layout, agent, onBack, onEdit, onRemove, onFocusDesk }: AgentDetailProps) {
  const { state, actions } = workforce
  const desk = deskStatus(layout, agent)
  const groups = deskOptions(layout, state, agent.id)
  const task = state.tasks.find((t) => t.id === agent.currentTaskId)
  const active = task && isActiveTask(task)
  const timeline = agentTimeline(state, agent.id)
  const [deskError, setDeskError] = useState<string | null>(null)
  const pickDesk = async (value: string) => {
    const r = await actions.assignDesk(agent.id, value || null)
    setDeskError(r.ok ? null : r.error)
  }
  const [actionError, setActionError] = useState<string | null>(null)
  const decision = useBusy()
  const cancel = useBusy()
  const decide = async (value: 'approve' | 'deny') => {
    if (!task?.pendingApproval) return
    const r = await decision.run(() => actions.decideApproval(task.id, task.pendingApproval!.id, value))
    if (r !== undefined) setActionError(r.ok ? null : r.error)
  }
  const cancelTask = async () => {
    if (!task) return
    const r = await cancel.run(() => actions.cancelTask(task.id))
    if (r !== undefined) setActionError(r.ok ? null : r.error)
  }
  const start = async (input: TaskInput) => {
    const r = await actions.startTask(agent.id, input)
    return r.ok ? null : r.error
  }

  return <>
    <button className="panel-link" onClick={onBack}><ArrowLeft size={13}/> All agents</button>
    <div className="agent-header">
      <StatusDot status={agent.status}/>
      <div><strong>{agent.name}</strong><small>{agent.role} · {DEPARTMENTS[agent.department].label}</small></div>
      {agent.demo && <span className="agent-chip demo">Demo</span>}
    </div>
    <div className="field-static"><span>Status</span><strong>{agentStatusText(state, agent)}</strong></div>
    <div className="panel-actions">
      <button className="panel-button" onClick={onEdit}><Pencil size={13}/> Edit</button>
      <button className="panel-button danger" onClick={onRemove}><Trash2 size={13}/> Remove</button>
    </div>

    <div className="field-group-label section">Workstation</div>
    {desk.kind === 'unavailable' && <p className="desk-warning" role="status"><AlertTriangle size={12}/> Workstation unavailable — {desk.deskId} is no longer in the layout. Pick another desk.</p>}
    {desk.kind === 'assigned' && <p className="panel-hint">{desk.label} · {desk.roomName}</p>}
    <label className="field"><span>Desk</span>
      <select className="field-input" value={agent.deskId ?? ''} onChange={(e) => pickDesk(e.target.value)}>
        <option value="">No desk</option>
        {desk.kind === 'unavailable' && <option value={desk.deskId} disabled>{desk.deskId} (unavailable)</option>}
        {groups.map((g) => <optgroup key={g.roomId ?? 'open'} label={g.roomName}>{g.desks.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</optgroup>)}
      </select>
    </label>
    {deskError && <p className="form-error" role="alert">{deskError}</p>}
    {desk.kind !== 'none' && <div className="panel-actions">
      <button className="panel-button" onClick={onFocusDesk} disabled={desk.kind === 'unavailable'}><LocateFixed size={13}/> {desk.kind === 'assigned' ? 'Focus desk' : 'Desk not in the layout'}</button>
    </div>}

    <div className="field-group-label section">Current task</div>
    {task ? <div className={`task-card ${task.status}`}>
      <div className="task-card-head"><strong>{task.title}</strong><span className="agent-chip">{TASK_STATUS_LABEL[task.status]}</span></div>
      {task.description && <p>{task.description}</p>}
      <small>{task.startedAt ? `Started ${formatTime(task.startedAt)}` : `Queued ${formatTime(task.createdAt)}`}{task.completedAt && ` · Ended ${formatTime(task.completedAt)}`} · {TASK_RUNTIME_LABEL[task.runtime]}</small>
      {task.resultSummary && <p className="task-result">{task.resultSummary}</p>}
      {task.errorMessage && <p className="task-error">{task.errorMessage}</p>}
    </div> : <p className="panel-hint">No task yet.</p>}
    {task?.status === 'waiting_for_approval' && task.pendingApproval && <div className="approval-card" role="status">
      <div className="task-card-head"><strong>Approval needed</strong><span className="agent-chip">{task.pendingApproval.tool}</span></div>
      <p>{task.pendingApproval.summary}</p>
      <div className="panel-actions">
        <button className="panel-button primary" disabled={decision.busy} onClick={() => decide('approve')}><Check size={13}/> Approve</button>
        <button className="panel-button danger" disabled={decision.busy} onClick={() => decide('deny')}><X size={13}/> Deny</button>
      </div>
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
    </div>}
    {active ? <>
      {task.status !== 'cancelling' && <div className="panel-actions"><button className="panel-button" disabled={cancel.busy} onClick={cancelTask}><Square size={13}/> Cancel task</button></div>}
      {actionError && task.status !== 'waiting_for_approval' && <p className="form-error" role="alert">{actionError}</p>}
      {task.status === 'running' && <>
        <div className="field-group-label">Demo controls</div>
        <div className="panel-actions">
          <button className="panel-button" onClick={() => actions.requestApproval(task.id)}><ShieldQuestion size={13}/> Simulate approval request</button>
          <button className="panel-button danger" onClick={() => actions.forceError(task.id)}><OctagonX size={13}/> Simulate error</button>
        </div>
      </>}
    </> : <TaskForm onStart={start}/>}

    <div className="field-group-label section">Activity</div>
    {timeline.length === 0 ? <p className="panel-hint">No activity yet.</p> : <ol className="activity-list">{timeline.map((a) => <li key={a.id}>
      <time dateTime={a.timestamp}>{formatTime(a.timestamp)}</time>
      <span>{a.message}</span>
      {a.source === 'mock' && a.type.startsWith('task-') && <span className="agent-chip sim">Simulated</span>}
    </li>)}</ol>}
  </>
}
