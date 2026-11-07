import type { ApiClient } from '../workforce/remote/client'
import type { LayoutResponse } from './api'
import { createDefaultLayout } from './defaultLayout'
import { loadLayout, parseLayout, serializeLayout } from './storage'
import type { OfficeLayout } from './types'

// Loading and saving the layout through the backend. Pure: no React, and the browser copy is only ever read.

type KV = Pick<Storage, 'getItem' | 'setItem'>
export type ServerLoadReady = { ok: true; layout: OfficeLayout; savedJson: string | null; problem: 'corrupt' | 'unsupported-version' | null; saveError: string | null }
/** status is the HTTP status, or null when no answer arrived. */
export type ServerLoadFailure = { ok: false; status: number | null; error: string }

const UNREADABLE = 'The server sent a layout this version cannot read.'

/** Saves exactly what saveLayout does in the browser, but to the server. */
export async function saveToServer(api: ApiClient, layout: OfficeLayout): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  const json = serializeLayout(layout)
  const normalised = parseLayout(JSON.parse(json))
  if (!normalised) return { ok: false, error: 'The layout failed validation and was not saved.' }
  const r = await api.send('PUT', '/api/layout', { layout: normalised })
  return r.ok ? { ok: true, json } : { ok: false, error: r.error }
}

export async function loadFromServer(api: ApiClient, storage: KV | null, signal?: AbortSignal): Promise<ServerLoadReady | ServerLoadFailure> {
  const r = await api.get<LayoutResponse>('/api/layout', signal)
  if (!r.ok) return { ok: false, status: r.status, error: r.error }
  const body = r.body as Partial<LayoutResponse> | undefined
  if (typeof body !== 'object' || body === null) return { ok: false, status: r.status, error: UNREADABLE }
  const problem = body.loadProblem === 'corrupt' || body.loadProblem === 'unsupported-version' ? body.loadProblem : null
  if (body.layout !== null && body.layout !== undefined) {
    const layout = parseLayout(body.layout)
    return layout ? { ok: true, layout, savedJson: serializeLayout(layout), problem: null, saveError: null } : { ok: false, status: r.status, error: UNREADABLE }
  }
  // A file that exists but can't be read is never overwritten by the browser copy; the next save replaces it.
  if (problem) return { ok: true, layout: createDefaultLayout(), savedJson: null, problem, saveError: null }
  // First open: copy a valid browser layout to the server. The browser copy is only read.
  const local = loadLayout(storage)
  if (local.problem === null) {
    const saved = await saveToServer(api, local.layout)
    return saved.ok
      ? { ok: true, layout: local.layout, savedJson: saved.json, problem: null, saveError: null }
      : { ok: true, layout: local.layout, savedJson: null, problem: null, saveError: saved.error }
  }
  return { ok: true, layout: createDefaultLayout(), savedJson: null, problem: null, saveError: null }
}
