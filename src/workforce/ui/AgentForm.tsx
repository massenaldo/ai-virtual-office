import { useState, type FormEvent } from 'react'
import { DEPARTMENTS } from '../../layout/catalog'
import type { Awaitable } from '../controller'
import { useBusy } from './useBusy'
import { NAME_MAX, ROLE_MAX, type AgentInput } from '../operations'
import { AGENT_DESCRIPTION_MAX, AGENT_INSTRUCTIONS_MAX, type Agent } from '../types'
import { AGENT_DEPARTMENTS } from '../view'

export type AgentFormProps = { agent?: Agent; onSubmit(input: AgentInput): Awaitable<string | null>; onCancel(): void }

/** What the form holds: the model is text until it is sent. */
export type AgentDraft = Omit<AgentInput, 'model'> & { model: string }

/** An empty Model field means the server default. */
export const toAgentInput = (d: AgentDraft): AgentInput => ({ ...d, model: d.model.trim() || null })

/** Sends the draft; returns the error to show, or null when it was applied. */
export const attemptSave = async (onSubmit: AgentFormProps['onSubmit'], d: AgentDraft): Promise<string | null> => onSubmit(toAgentInput(d))

/** Create or edit form. onSubmit returns an error message, or null when it was applied. */
export default function AgentForm({ agent, onSubmit, onCancel }: AgentFormProps) {
  const [input, setInput] = useState<AgentDraft>({ name: agent?.name ?? '', role: agent?.role ?? '', department: agent?.department ?? 'backend', description: agent?.description ?? '', instructions: agent?.instructions ?? '', model: agent?.model ?? '', takesPrayerBreaks: agent?.takesPrayerBreaks ?? true })
  const [error, setError] = useState<string | null>(null)
  const { busy, run } = useBusy()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const result = await run(() => attemptSave(onSubmit, input))
    if (result !== undefined) setError(result)
  }
  return <form onSubmit={submit} noValidate>
    <label className="field"><span>Name</span><input className="field-input" value={input.name} maxLength={NAME_MAX} autoFocus onChange={(e) => setInput({ ...input, name: e.target.value })}/></label>
    <label className="field"><span>Role</span><input className="field-input" value={input.role} maxLength={ROLE_MAX} placeholder="e.g. API engineer" onChange={(e) => setInput({ ...input, role: e.target.value })}/></label>
    <label className="field"><span>Department</span>
      <select className="field-input" value={input.department} onChange={(e) => setInput({ ...input, department: e.target.value as AgentInput['department'] })}>
        {AGENT_DEPARTMENTS.map((id) => <option key={id} value={id}>{DEPARTMENTS[id].label}</option>)}
      </select>
    </label>
    <label className="field"><span>Description</span><textarea className="field-input" value={input.description} maxLength={AGENT_DESCRIPTION_MAX} rows={2} onChange={(e) => setInput({ ...input, description: e.target.value })}/></label>
    <label className="field"><span>Instructions</span><textarea className="field-input" value={input.instructions} maxLength={AGENT_INSTRUCTIONS_MAX} rows={5} onChange={(e) => setInput({ ...input, instructions: e.target.value })}/></label>
    <p className="panel-hint">Describes this agent's job. It can't give the agent extra tools or permissions.</p>
    <label className="field"><span>Model</span><input className="field-input" value={input.model} placeholder="Server default" spellCheck={false} onChange={(e) => setInput({ ...input, model: e.target.value })}/></label>
    <p className="panel-hint">Only used on the Claude runtime. Leave empty for the server default.</p>
    <label className="field-check"><input type="checkbox" checked={input.takesPrayerBreaks} onChange={(e) => setInput({ ...input, takesPrayerBreaks: e.target.checked })}/><span>Takes prayer breaks</span></label>
    <p className="panel-hint">Takes effect when the daily routine arrives in a later update.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="panel-actions">
      <button type="submit" className="panel-button primary" disabled={busy}>{agent ? 'Save changes' : 'Create agent'}</button>
      <button type="button" className="panel-button" onClick={onCancel}>Cancel</button>
    </div>
  </form>
}
