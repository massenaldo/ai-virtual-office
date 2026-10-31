import { useState, type FormEvent } from 'react'
import { DEPARTMENTS } from '../../layout/catalog'
import type { Awaitable } from '../controller'
import { NAME_MAX, ROLE_MAX, type AgentInput } from '../operations'
import type { Agent } from '../types'
import { AGENT_DEPARTMENTS } from '../view'

export type AgentFormProps = { agent?: Agent; onSubmit(input: AgentInput): Awaitable<string | null>; onCancel(): void }

/** Create or edit form. onSubmit returns an error message, or null when it was applied. */
export default function AgentForm({ agent, onSubmit, onCancel }: AgentFormProps) {
  const [input, setInput] = useState<AgentInput>({ name: agent?.name ?? '', role: agent?.role ?? '', department: agent?.department ?? 'backend' })
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(await onSubmit(input))
  }
  return <form onSubmit={submit} noValidate>
    <label className="field"><span>Name</span><input className="field-input" value={input.name} maxLength={NAME_MAX} autoFocus onChange={(e) => setInput({ ...input, name: e.target.value })}/></label>
    <label className="field"><span>Role</span><input className="field-input" value={input.role} maxLength={ROLE_MAX} placeholder="e.g. API engineer" onChange={(e) => setInput({ ...input, role: e.target.value })}/></label>
    <label className="field"><span>Department</span>
      <select className="field-input" value={input.department} onChange={(e) => setInput({ ...input, department: e.target.value as AgentInput['department'] })}>
        {AGENT_DEPARTMENTS.map((id) => <option key={id} value={id}>{DEPARTMENTS[id].label}</option>)}
      </select>
    </label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="panel-actions">
      <button type="submit" className="panel-button primary">{agent ? 'Save changes' : 'Create agent'}</button>
      <button type="button" className="panel-button" onClick={onCancel}>Cancel</button>
    </div>
  </form>
}
