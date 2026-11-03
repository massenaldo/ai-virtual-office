import { Check, X } from 'lucide-react'
import { allowedScopes, scopeSentence } from '../view'

export type Scope = 'once' | 'task' | 'agent'

const LABEL: Record<Scope, string> = { once: 'Once', task: 'This task', agent: 'This agent' }

export type ApprovalChoiceFormProps = {
  approvalId: string
  tool: string
  /** The pending approval's action digest; null for a simulated approval. */
  digest: string | null
  /** The server only accepts Once for this approval (a file that tools run on their own). */
  onceOnly?: boolean
  agentName: string
  scope: Scope
  onScope(scope: Scope): void
  /** False until the full change has been opened (and while a decision is in flight). Reject is never held back by this. */
  canAllow: boolean
  busy: boolean
  onAllow(): void
  onReject(): void
}

/** The backend's way to answer an approval: how far the allow reaches, then Allow or Reject. The server checks the digest, the scope and the tool's ceiling again. */
export default function ApprovalChoiceForm({ approvalId, tool, digest, onceOnly = false, agentName, scope, onScope, canAllow, busy, onAllow, onReject }: ApprovalChoiceFormProps) {
  const scopes = allowedScopes(tool, digest, onceOnly)
  // A stale choice (from an earlier approval of a broader tool) never shows as selected.
  const chosen: Scope = scopes.includes(scope) ? scope : 'once'
  return <>
    <fieldset className="scope-choice" disabled={busy}>
      <legend>Allow for</legend>
      {scopes.map((s) => <label key={s} className="scope-option">
        <input type="radio" name={`scope-${approvalId}`} value={s} checked={chosen === s} onChange={() => onScope(s)}/>
        <span>{LABEL[s]}</span>
      </label>)}
    </fieldset>
    {scopes.length === 1 && <small className="panel-hint">{onceOnly ? 'This change can only be allowed once: it is to a file that tools run on their own, or this server only allows writes one at a time.' : `${digest === null ? 'A simulated request' : tool} can only be allowed once; the server refuses anything broader.`}</small>}
    <p className="scope-sentence" role="status">{scopeSentence(chosen, tool, agentName)}</p>
    <div className="panel-actions">
      <button type="button" className="panel-button primary" disabled={busy || !canAllow} onClick={onAllow}><Check size={13}/> Allow</button>
      <button type="button" className="panel-button danger" disabled={busy} onClick={onReject}><X size={13}/> Reject</button>
    </div>
  </>
}
