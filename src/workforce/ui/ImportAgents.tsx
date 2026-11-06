import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Download, RefreshCw } from 'lucide-react'
import type { DialogRequest } from '../../editor/useEditorActions'
import { DEPARTMENTS } from '../../layout/catalog'
import type { AgentFilePreview, AgentFilesResponse } from '../api'
import type { WorkforceController } from '../controller'
import { ROLE_MAX, type AgentInput } from '../operations'
import { AGENT_DEPARTMENTS } from '../view'
import { IMPORT_FIELD_LABEL, IMPORT_NEEDS_SERVER, NO_WORKSPACE, attemptImport, attemptReimport, reimportPrompt } from './importAgentsLogic'
import { useBusy } from './useBusy'

export type Listing = { kind: 'loading' } | { kind: 'error'; error: string } | { kind: 'ready'; response: AgentFilesResponse }
type Readable = Extract<AgentFilePreview, { ok: true }>

const TOOLS_NOTE = 'A file can not grant tools and can not restrict them either: tools: Read, Grep still leaves an agent that can ask for Write, which needs approval.'

type RowProps = { file: AgentFilePreview; onImport(file: Readable, role: string, department: AgentInput['department']): Promise<unknown>; onReimport(file: Readable): void }

/** One file. Everything shown comes from the server's reading of it, as plain text: a file grants nothing. */
function ImportRow({ file, onImport, onReimport }: RowProps) {
  const readable = file.ok ? file : null
  const [role, setRole] = useState(readable?.suggestedRole ?? '')
  const [department, setDepartment] = useState<AgentInput['department'] | ''>('')
  const { busy, run } = useBusy()
  if (!readable) return <li className="import-row">
    <strong>{file.file}</strong>
    <p className="form-error" role="alert">{file.ok ? '' : file.error}</p>
  </li>
  const { agent, existing } = readable
  const canAct = readable.digest !== ''
  return <li className="import-row">
    <strong>{agent.name}</strong>
    <small>{readable.file}</small>
    {agent.description && <p className="panel-hint">{agent.description}</p>}
    <div className="field-static"><span>Model</span><strong>{agent.model ?? 'Server default'}</strong></div>
    <div className="field-group-label">Instructions</div>
    <pre className="import-instructions" tabIndex={0}>{agent.instructions}</pre>
    {agent.ignoredFields.length > 0 && <p className="panel-hint">Ignored: {agent.ignoredFields.join(', ')}</p>}
    {agent.ignoredFields.includes('tools') && <p className="panel-hint">{TOOLS_NOTE}</p>}
    {agent.secretsMasked && <p className="panel-hint">Text that looks like a secret was replaced with [REDACTED]. Check it before importing.</p>}
    {agent.descriptionCut && <p className="panel-hint">The description was cut short.</p>}
    {existing
      ? existing.changes.length === 0
        ? <p className="panel-hint">No changes</p>
        : <>
          <p className="panel-hint">Changes: {existing.changes.map((c) => IMPORT_FIELD_LABEL[c]).join(', ')}</p>
          {canAct && <div className="panel-actions"><button type="button" className="panel-button" disabled={busy} onClick={() => onReimport(readable)}><RefreshCw size={13}/> Re-import</button></div>}
        </>
      : canAct && <form noValidate onSubmit={(e) => { e.preventDefault(); if (department !== '' && !busy) void run(() => onImport(readable, role, department)) }}>
        <label className="field"><span>Role</span><input className="field-input" value={role} maxLength={ROLE_MAX} onChange={(e) => setRole(e.target.value)}/></label>
        <label className="field"><span>Department</span>
          <select className="field-input" required value={department} onChange={(e) => setDepartment(e.target.value as AgentInput['department'])}>
            <option value="">Choose a department</option>
            {AGENT_DEPARTMENTS.map((id) => <option key={id} value={id}>{DEPARTMENTS[id].label}</option>)}
          </select>
        </label>
        <div className="panel-actions"><button type="submit" className="panel-button primary" disabled={department === '' || busy}><Download size={13}/> Import</button></div>
      </form>}
  </li>
}

export type ImportBodyProps = {
  workspaces: string[]
  workspaceId: string
  onWorkspace(id: string): void
  listing: Listing
  notice: string | null
  error?: string | null
  onBack(): void
  onRefresh?(): void
  onImport: RowProps['onImport']
  onReimport: RowProps['onReimport']
}

/** The list and its messages, driven by props so every case can be shown without a server. */
export function ImportAgentsBody({ workspaces, workspaceId, onWorkspace, listing, notice, error, onBack, onRefresh, onImport, onReimport }: ImportBodyProps) {
  return <>
    <button className="panel-link" onClick={onBack}><ArrowLeft size={13}/> All agents</button>
    <div className="field-group-label">Import agents</div>
    <p className="panel-hint">Reads .claude/agents in a workspace. A file sets only the name, description, model and instructions. It cannot give an agent tools or permissions.</p>
    {workspaces.length > 1 && <label className="field"><span>Workspace</span>
      <select className="field-input" value={workspaceId} onChange={(e) => onWorkspace(e.target.value)}>
        {workspaces.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>}
    {onRefresh && <div className="panel-actions"><button type="button" className="panel-button" onClick={onRefresh}><RefreshCw size={13}/> Load again</button></div>}
    {notice && <p className="panel-hint" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {listing.kind === 'loading' && <p className="panel-hint" role="status">Loading agent files…</p>}
    {listing.kind === 'error' && <p className="form-error" role="alert">{listing.error}</p>}
    {listing.kind === 'ready' && (listing.response.folder === 'refused'
      ? <p className="panel-hint">The .claude/agents folder is a link or not a real folder, so it was not read.</p>
      : listing.response.folder === 'missing'
      ? <p className="panel-hint">This workspace has no .claude/agents folder.</p>
      : listing.response.files.length === 0
        ? <p className="panel-hint">No agent files found in .claude/agents.</p>
        : <>
          {listing.response.cut && <p className="panel-hint">Only the first files are shown.</p>}
          <ul className="import-list">{listing.response.files.map((f) => <ImportRow key={`${f.file}:${f.digest}`} file={f} onImport={onImport} onReimport={onReimport}/>)}</ul>
        </>)}
  </>
}

export type ImportAgentsProps = {
  /** null in browser mode. */
  workspaces: string[] | null
  actions: Pick<WorkforceController, 'listAgentFiles' | 'importAgent' | 'reimportAgent'>
  onBack(): void
  openDialog(d: DialogRequest): void
}

export default function ImportAgents({ workspaces, actions, onBack, openDialog }: ImportAgentsProps) {
  const [picked, setPicked] = useState<string | null>(null)
  const workspaceId = workspaces && picked !== null && workspaces.includes(picked) ? picked : (workspaces?.[0] ?? '')
  const [listing, setListing] = useState<Listing>({ kind: 'loading' })
  const [reloads, setReloads] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { listAgentFiles } = actions

  useEffect(() => {
    if (workspaceId === '' || !listAgentFiles) return
    let current = true
    void listAgentFiles(workspaceId).then((r) => {
      if (current) setListing(r.ok ? { kind: 'ready', response: r.response } : { kind: 'error', error: r.error })
    })
    return () => { current = false }
  }, [workspaceId, listAgentFiles, reloads])

  // Loading is shown only when the workspace changes; a refresh keeps the rows (keyed by file and digest) and what was typed in them.
  useEffect(() => { setListing({ kind: 'loading' }) }, [workspaceId])

  const refresh = useCallback(() => setReloads((n) => n + 1), [])
  // Whatever happened, the list is read again: a changed or already imported file shows its new state.
  const settle = (failure: string | null, success: string) => {
    setError(failure)
    setNotice(failure === null ? success : null)
    refresh()
  }

  if (workspaces === null) return <><button className="panel-link" onClick={onBack}><ArrowLeft size={13}/> All agents</button><p className="panel-hint">{IMPORT_NEEDS_SERVER}</p></>
  if (workspaces.length === 0) return <>
    <button className="panel-link" onClick={onBack}><ArrowLeft size={13}/> All agents</button>
    <p className="panel-hint">{NO_WORKSPACE}</p>
    <p className="panel-hint">For example, in .env: WORKSPACE_ROOT=/path/to/projects and WORKSPACES=sandbox:my-project. The README section "Import agents from role files" shows the whole setup.</p>
  </>

  return <ImportAgentsBody
    workspaces={workspaces} workspaceId={workspaceId} onWorkspace={(id) => { setPicked(id); setNotice(null); setError(null) }}
    listing={listing} notice={notice} error={error} onBack={onBack} onRefresh={refresh}
    onImport={async (file, role, department) => settle(await attemptImport(actions.importAgent, workspaceId, file, role, department), `Imported ${file.agent.name}.`)}
    onReimport={(file) => {
      if (!file.existing) return
      const { agentId, changes } = file.existing
      openDialog({ ...reimportPrompt(file.file, changes), actions: [{ label: 'Re-import', tone: 'primary', onClick: () => { void attemptReimport(actions.reimportAgent, agentId, file.digest).then((f) => settle(f, `Updated the agent from ${file.file}.`)) } }] })
    }}
  />
}
