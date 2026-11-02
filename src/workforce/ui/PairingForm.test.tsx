import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkforce } from '../demo'
import type { WorkforceController, WorkforceSnapshot } from '../controller'
import type { Workforce } from '../useWorkforce'
import PairingForm, { attemptPairing } from './PairingForm'
import WorkforcePanel from './WorkforcePanel'

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

  it('writes nothing to localStorage or sessionStorage', async () => {
    const store = { setItem: vi.fn(), getItem: vi.fn() }
    vi.stubGlobal('localStorage', store)
    vi.stubGlobal('sessionStorage', store)
    await attemptPairing(async () => ({ ok: false, error: 'no' }), 'tok')
    expect(store.setItem).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('WorkforcePanel pairing', () => {
  const layout = { furniture: [] } as never
  const base = (over: Partial<WorkforceSnapshot>, actions: Partial<WorkforceController>): Workforce => ({
    state: createDemoWorkforce('2026-10-31T09:00:00.000Z'), loadProblem: null, preserved: null, saveError: null,
    environment: { kind: 'backend', runtime: null, available: null, reason: null }, connection: 'offline', lastSyncedAt: null,
    commandError: null, connectionError: 'Not authorized. Something.', needsPairing: false, ...over, actions: actions as WorkforceController,
  })
  const render = (w: Workforce) => renderToStaticMarkup(<WorkforcePanel workforce={w} layout={layout} view={{ kind: 'list' }} onViewChange={() => {}} onFocusDesk={() => {}} openDialog={() => {}}/>)

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
})
