import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentFilePreview, AgentFilesResponse } from '../api'
import type { WorkforceController } from '../controller'
import { attemptImport, attemptReimport, reimportPrompt } from './importAgentsLogic'
import { ROLE_MAX } from '../operations'
import { createDefaultLayout } from '../../layout/defaultLayout'
import { createDemoWorkforce } from '../demo'
import AgentList from './AgentList'
import ImportAgents, { ImportAgentsBody, type Listing } from './ImportAgents'

const good = (over: Partial<Extract<AgentFilePreview, { ok: true }>> = {}, agent: Partial<Extract<AgentFilePreview, { ok: true }>['agent']> = {}): AgentFilePreview => ({
  file: 'backend-engineer.md', digest: 'ab'.repeat(32), ok: true, suggestedRole: 'Backend Engineer', existing: null,
  agent: { name: 'Backend Engineer', description: 'Builds the API.', model: null, instructions: 'Write careful code.\n<script>alert(1)</script>', ignoredFields: [], descriptionCut: false, secretsMasked: false, ...agent },
  ...over,
})
const response = (files: AgentFilePreview[], over: Partial<AgentFilesResponse> = {}): AgentFilesResponse => ({ folder: 'found', cut: false, files, ...over })

const noop = async () => null
const body = (listing: Listing, over: Partial<Parameters<typeof ImportAgentsBody>[0]> = {}) =>
  renderToStaticMarkup(<ImportAgentsBody workspaces={['sandbox']} workspaceId="sandbox" onWorkspace={() => {}} listing={listing} notice={null} onBack={() => {}} onImport={noop} onReimport={() => {}} {...over}/>)
/** Only the file rows: the screen's own back button is not an action on a file. */
const rows = (html: string) => html.slice(html.indexOf('<ul class="import-list">'))
const ready = (files: AgentFilePreview[], over: Partial<AgentFilesResponse> = {}): Listing => ({ kind: 'ready', response: response(files, over) })

describe('ImportAgents without a workspace', () => {
  const actions = { listAgentFiles: vi.fn(), importAgent: vi.fn(), reimportAgent: vi.fn() } as unknown as Pick<WorkforceController, 'listAgentFiles' | 'importAgent' | 'reimportAgent'>
  const screen = (workspaces: string[] | null) => renderToStaticMarkup(<ImportAgents workspaces={workspaces} actions={actions} onBack={() => {}} openDialog={() => {}}/>)

  it('says the server is needed in browser mode, and calls nothing', () => {
    expect(screen(null)).toContain('Importing agents needs the server. Start the app with npm run dev:full.')
    expect(actions.listAgentFiles).not.toHaveBeenCalled()
  })

  it('tells how to set a workspace up when there is none', () => {
    const h = screen([])
    expect(h).toContain('No workspace is set up yet. Set WORKSPACE_ROOT and WORKSPACES in .env and restart the server.')
    expect(h).toContain('README')
    expect(actions.listAgentFiles).not.toHaveBeenCalled()
  })
})

describe('ImportAgentsBody listing states', () => {
  it('says so for a missing folder and an empty one', () => {
    expect(body(ready([], { folder: 'missing' }))).toContain('This workspace has no .claude/agents folder.')
    const refused = body(ready([], { folder: 'refused' }))
    expect(refused).toContain('The .claude/agents folder is a link or not a real folder, so it was not read.')
    expect(refused).not.toContain('has no .claude/agents folder')
    const empty = body(ready([]))
    expect(empty).toContain('No agent files found in .claude/agents.')
    expect(empty).not.toContain('has no .claude/agents folder')
  })

  it('shows a load error as an alert and a loading note while waiting', () => {
    expect(body({ kind: 'error', error: 'Workspace not found.' })).toContain('role="alert">Workspace not found.')
    expect(body({ kind: 'loading' })).toContain('Loading agent files')
  })

  it('says when the list was cut', () => {
    expect(body(ready([good()], { cut: true }))).toContain('Only the first files are shown.')
  })

  it('offers a workspace choice only with more than one', () => {
    expect(body(ready([]))).not.toContain('<select')
    expect(body(ready([]), { workspaces: ['a', 'b'] })).toContain('<option value="b">b</option>')
  })
})

describe('a good file', () => {
  const h = body(ready([good()]))

  it('shows name, description, the server default model and the full instructions as text', () => {
    expect(h).toContain('Backend Engineer')
    expect(h).toContain('Builds the API.')
    expect(h).toContain('Server default')
    expect(h).toContain('Write careful code.')
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(h).not.toContain('<script>')
    expect(h).toContain('import-instructions')
  })

  it('shows the model when the file names one', () => {
    expect(body(ready([good({}, { model: 'claude-sonnet-4-5' })]))).toContain('claude-sonnet-4-5')
  })

  it('seeds Role from the suggestion and has a required Department with no default', () => {
    expect(h).toMatch(/<input[^>]*value="Backend Engineer"/)
    expect(h).toMatch(/<select[^>]*required=""[^>]*>\s*<option value="" selected="">Choose a department<\/option>/)
    expect(h).not.toMatch(/<option[^>]*value="backend"[^>]*selected/)
  })

  it('keeps Import disabled until a department is chosen', () => {
    const button = h.split('<button').find((b) => b.includes('>Import</button>') || b.includes('Import</button>'))!
    expect(button).toContain('disabled=""')
  })

  it('lists ignored fields, and says nothing when there are none', () => {
    expect(body(ready([good({}, { ignoredFields: ['tools', 'permissionMode'] })]))).toContain('Ignored: tools, permissionMode')
    expect(body(ready([good({}, { ignoredFields: ['tools'] })]))).toContain('A file can not grant tools and can not restrict them either: tools: Read, Grep still leaves an agent that can ask for Write, which needs approval.')
    expect(h).not.toContain('Ignored:')
  })

  it('notes a masked secret and a cut description', () => {
    const n = body(ready([good({}, { secretsMasked: true, descriptionCut: true })]))
    expect(n).toContain('Text that looks like a secret was replaced with [REDACTED]. Check the instructions below.')
    expect(n).toContain('The description was cut short.')
    expect(h).not.toContain('replaced with [REDACTED]')
    expect(h).not.toContain('cut short')
  })

  it('does not offer Import without a digest', () => {
    const none = body(ready([good({ digest: '' })]))
    expect(none).not.toContain('Import</button>')
  })
})

describe('a bad file', () => {
  const bad: AgentFilePreview = { file: '(file 3)', digest: '', ok: false, error: 'The file has no name.' }
  const h = rows(body(ready([bad])))

  it('shows its label and error and offers no action', () => {
    expect(h).toContain('(file 3)')
    expect(h).toContain('The file has no name.')
    expect(h).not.toContain('<button')
    expect(h).not.toContain('<input')
  })

  it('offers nothing even when a bad file carries a digest', () => {
    expect(rows(body(ready([{ ...bad, digest: 'ab'.repeat(32) }])))).not.toContain('<button')
  })
})

describe('an already imported file', () => {
  const imported = (changes: Array<'description' | 'model' | 'instructions'>) => body(ready([good({ existing: { agentId: 'a1', changes } })]))

  it('offers Re-import instead of Import and lists what would change', () => {
    const h = imported(['description', 'instructions'])
    expect(h).toContain('Re-import</button>')
    expect(h).not.toMatch(/>Import<\/button>/)
    expect(h).toContain('Changes: description, instructions')
    expect(h).not.toContain('Choose a department')
  })

  it('says No changes, with no button, when nothing differs', () => {
    const h = rows(imported([]))
    expect(h).toContain('No changes')
    expect(h).not.toContain('<button')
  })
})

describe('reimportPrompt', () => {
  it('asks first and says what stays as it is', () => {
    const p = reimportPrompt('backend-engineer.md', ['model'])
    expect(p.title).toBe('Re-import backend-engineer.md?')
    expect(p.message).toContain('The name, role, department and desk stay as they are.')
    expect(p.message).toContain('model')
  })
})

describe('attemptImport and attemptReimport', () => {
  const preview = good() as Extract<AgentFilePreview, { ok: true }>

  it('sends the preview digest with the chosen role and department, and reports success', async () => {
    const importAgent = vi.fn(async () => ({ ok: true as const, agentId: 'a1' }))
    expect(await attemptImport(importAgent, 'sandbox', preview, 'Lead', 'backend')).toBeNull()
    expect(importAgent).toHaveBeenCalledWith({ workspaceId: 'sandbox', file: 'backend-engineer.md', digest: 'ab'.repeat(32), role: 'Lead', department: 'backend' })
  })

  it('never sends an empty digest', async () => {
    const importAgent = vi.fn()
    const r = await attemptImport(importAgent, 'sandbox', { ...preview, digest: '' }, 'Lead', 'backend')
    expect(importAgent).not.toHaveBeenCalled()
    expect(r).toBeTruthy()
    const reimport = vi.fn()
    expect(await attemptReimport(reimport, 'a1', '')).toBeTruthy()
    expect(reimport).not.toHaveBeenCalled()
  })

  it('turns the changed-file 409 into the short sentence', async () => {
    const msg = 'That agent file changed since you looked at it. Open the list again and review it.'
    expect(await attemptImport(async () => ({ ok: false, error: msg, status: 409 }), 'w', preview, 'R', 'design')).toBe('This file changed since the preview. Load it again.')
    expect(await attemptReimport(async () => ({ ok: false, error: msg, status: 409 }), 'a1', 'ab')).toBe('This file changed since the preview. Load it again.')
  })

  it('shows any other refusal in the server words, including an already imported 409', async () => {
    const already = 'That file is already imported as Nova. Use re-import to update it.'
    expect(await attemptImport(async () => ({ ok: false, error: already, status: 409 }), 'w', preview, 'R', 'design')).toBe(already)
    expect(await attemptImport(async () => ({ ok: false, error: 'Nope.', status: 422 }), 'w', preview, 'R', 'design')).toBe('Nope.')
  })

  it('reports that import is unavailable when the action is missing', async () => {
    expect(await attemptImport(undefined, 'w', preview, 'R', 'design')).toBe('Importing agents needs the server. Start the app with npm run dev:full.')
  })
})

describe('the role field', () => {
  it('allows as many characters as the server does', () => {
    const f = good({}, {})
    expect(body(ready([f]))).toContain(`maxLength="${ROLE_MAX}"`)
  })
})

describe('AgentList import link', () => {
  const list = (onImport: () => void) => renderToStaticMarkup(<AgentList state={createDemoWorkforce('2026-11-06T09:00:00.000Z')} layout={createDefaultLayout()} onOpen={() => {}} onCreate={() => {}} onImport={onImport} onRestoreDemo={() => {}}/>)
  it('sits next to New agent', () => {
    expect(list(() => {})).toContain('Import agents</button>')
  })
})
