import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from '../demo'
import type { WorkforceController, WorkforceSnapshot } from '../controller'
import type { Workforce } from '../useWorkforce'
import PairingForm, { attemptPairing } from './PairingForm'
import WorkforcePanel, { type WorkforceView } from './WorkforcePanel'

afterEach(() => vi.restoreAllMocks())

describe('PairingForm markup', () => {
  const html = renderToStaticMarkup(<PairingForm onPair={async () => ({ ok: true })}/>)

  it('has a password input that does not autocomplete or spellcheck, and a submit button', () => {
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('spellCheck="false"')
    expect(html).toMatch(/<button[^>]*type="submit"/)
  })

  it('explains where the token is and which address to use', () => {
    expect(html).toContain('data folder')
    expect(html).not.toContain('api-token')
    expect(html).toContain('API_TOKEN')
    expect(html).toContain('127.0.0.1')
    expect(html).toContain('localhost')
  })

  it('has no error before an attempt and the input has no value attribute', () => {
    expect(html).not.toContain('form-error')
    expect(html).not.toMatch(/<input[^>]*value=/)
  })
})

describe('attemptPairing', () => {
  it('passes the typed token to onPair and returns null on success', async () => {
    const onPair = vi.fn(async () => ({ ok: true }))
    expect(await attemptPairing(onPair, 'abc')).toBeNull()
    expect(onPair).toHaveBeenCalledWith('abc')
  })

  it('returns the error text on failure, with a fallback when none is given', async () => {
    expect(await attemptPairing(async () => ({ ok: false, error: 'That token was not accepted.' }), 'x')).toBe('That token was not accepted.')
    expect(await attemptPairing(async () => ({ ok: false }), 'x')).toBe('Pairing failed.')
  })

  it('turns a throw into a message that never contains the token', async () => {
    const msg = await attemptPairing(async () => { throw new Error('boom s3cret') }, 's3cret')
    expect(msg).toBe('Pairing failed.')
  })

  it('never touches browser storage or cookies: the form source does not mention them', () => {
    const source = readFileSync(new URL('./PairingForm.tsx', import.meta.url), 'utf8')
    for (const word of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) expect(source).not.toContain(word)
  })

  it('refocuses the input once a failed attempt is over (a disabled input loses focus)', () => {
    const source = readFileSync(new URL('./PairingForm.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/useEffect\([\s\S]*\.focus\(\)[\s\S]*\[busy, error\]/)
  })
})

describe('PairingForm note', () => {
  it('shows the note above the form fields and omits the paragraph without one', () => {
    const withNote = renderToStaticMarkup(<PairingForm onPair={async () => ({ ok: true })} note="This page is open at localhost but the backend is at 127.0.0.1."/>)
    expect(withNote).toContain('This page is open at localhost but the backend is at 127.0.0.1.')
    expect(withNote.indexOf('This page is open')).toBeLessThan(withNote.indexOf('type="password"'))
    expect(renderToStaticMarkup(<PairingForm onPair={async () => ({ ok: true })}/>)).not.toContain('pairing-note')
  })
})

describe('WorkforcePanel pairing', () => {
  const layout = { furniture: [] } as never
  const base = (over: Partial<WorkforceSnapshot>, actions: Partial<WorkforceController>): Workforce => ({
    state: createDemoWorkforce('2026-10-31T09:00:00.000Z'), loadProblem: null, preserved: null, saveError: null,
    environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'offline', lastSyncedAt: null,
    commandError: null, connectionError: 'Not authorized. Something.', needsPairing: false, pairingNote: null, permissions: null, ...over, actions: actions as WorkforceController,
  })
  const render = (w: Workforce, view: WorkforceView = { kind: 'list' }) => renderToStaticMarkup(<WorkforcePanel workforce={w} layout={layout} view={view} onViewChange={() => {}} onFocusDesk={() => {}} openDialog={() => {}}/>)

  it('shows the form instead of the offline error and the waiting hint when needsPairing', () => {
    const html = render(base({ needsPairing: true }, { pair: async () => ({ ok: true }) }))
    expect(html).toContain('type="password"')
    expect(html).not.toContain('Not authorized')
    expect(html).not.toContain('Waiting for the local backend')
  })

  it('does not show the form when needsPairing is false', () => {
    const html = render(base({}, { pair: async () => ({ ok: true }) }))
    expect(html).not.toContain('type="password"')
    expect(html).toContain('Not authorized')
  })

  it('does not show the form when the controller cannot pair', () => {
    expect(render(base({ needsPairing: true }, {}))).not.toContain('type="password"')
  })

  it('shows the pairing note in the form', () => {
    const html = render(base({ needsPairing: true, pairingNote: 'Open the app at http://127.0.0.1:5173 so the browser keeps the session.' }, { pair: async () => ({ ok: true }) }))
    expect(html).toContain('Open the app at http://127.0.0.1:5173')
  })

  it('gates create, detail, edit and assign views behind pairing too', () => {
    const agentId = createDemoWorkforce('2026-10-31T09:00:00.000Z').agents[0].id
    const views: WorkforceView[] = [{ kind: 'create' }, { kind: 'detail', agentId }, { kind: 'edit', agentId }, { kind: 'assign', deskId: 'desk-1' }]
    const withDesk = { furniture: [{ id: 'desk-1', type: 'desk' }] } as never
    for (const view of views) {
      const html = renderToStaticMarkup(<WorkforcePanel workforce={base({ needsPairing: true }, { pair: async () => ({ ok: true }) })} layout={withDesk} view={view} onViewChange={() => {}} onFocusDesk={() => {}} openDialog={() => {}}/>)
      expect(html).toContain('type="password"')
      expect(html).not.toContain('New agent')
      expect(html).not.toContain('field-input" name')
      expect(html).not.toContain('Edit ')
      expect(html.match(/<input/g)).toHaveLength(1)
    }
  })
})
