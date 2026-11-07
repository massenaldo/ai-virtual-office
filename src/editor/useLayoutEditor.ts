import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import { createDefaultLayout } from '../layout/defaultLayout'
import { createEditorState, editorReducer, type EditorAction, type EditorState } from '../layout/history'
import { loadFromServer, saveToServer } from '../layout/serverLayout'
import { getBrowserStorage, loadLayout, parseLayout, saveLayout, type LoadProblem } from '../layout/storage'
import { createApiClient, type ApiClient } from '../workforce/remote/client'
import { resolveWorkforceSource } from '../workforce/source'
import { saveStatus, type SaveStatus } from './status'

/** loading: asking the server; ready: editable; offline: the server could not be reached, so what shows is read-only. */
export type LayoutPhase = 'loading' | 'ready' | 'offline'

export type LayoutEditor = {
  state: EditorState
  dispatch: Dispatch<EditorAction>
  status: SaveStatus
  saveError: string | null
  loadProblem: LoadProblem | null
  phase: LayoutPhase
  dismissLoadProblem(): void
  save(): Promise<boolean>
  resetToDefault(): void
  discardToSaved(): void
}

function savedLayout(json: string | null) {
  if (json === null) return null
  try {
    return parseLayout(JSON.parse(json))
  } catch {
    return null
  }
}

const noticeFor = (p: LoadProblem | null): LoadProblem | null => (p === 'corrupt' || p === 'unsupported-version' || p === 'unavailable' ? p : null)

/**
 * Editor state. With a backend the layout lives on the server (data/layout.json); otherwise (browser demo or a bad
 * config) it lives in localStorage and is loaded once, on first render. `connected` is whether the workforce link is
 * live: a layout that could not be loaded is tried again when it turns true, and never on a timer.
 */
export function useLayoutEditor(connected: boolean = false): LayoutEditor {
  const [source] = useState(() => resolveWorkforceSource(import.meta.env.VITE_WORKFORCE_API_URL))
  const [api] = useState<ApiClient | null>(() => (source.kind === 'backend' ? createApiClient({ baseUrl: source.baseUrl }) : null))
  const [initial] = useState(() => (api ? null : loadLayout(getBrowserStorage())))
  const [state, dispatch] = useReducer(editorReducer, initial, (i) => (i ? createEditorState(i.layout, i.savedJson) : createEditorState(createDefaultLayout(), null)))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [phase, setPhase] = useState<LayoutPhase>(api ? 'loading' : 'ready')
  const [attempt, setAttempt] = useState(0)
  // Only damaged or newer saved data deserves a notice; "nothing saved yet" is the normal first run.
  const [loadProblem, setLoadProblem] = useState<LoadProblem | null>(initial ? noticeFor(initial.problem) : null)

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const layoutRef = useRef(state.layout)
  layoutRef.current = state.layout
  const saves = useRef<Promise<unknown>>(Promise.resolve())

  // One GET per attempt; the first attempt runs on mount. An aborted attempt (unmount, StrictMode) is ignored.
  useEffect(() => {
    if (!api) return
    const controller = new AbortController()
    const startedConnected = connectedRef.current
    void loadFromServer(api, getBrowserStorage(), controller.signal).then((r) => {
      if (controller.signal.aborted) return
      if (r.ok) {
        dispatch({ type: 'loaded', layout: r.layout, savedJson: r.savedJson })
        setSaveError(r.saveError)
        setLoadProblem(r.problem)
        setPhase('ready')
        return
      }
      // The connection came up while this attempt was out, so the retry below has already passed: try once more.
      if (!startedConnected && connectedRef.current) {
        setAttempt((n) => n + 1)
        return
      }
      // Show what the browser has, read-only. A 401 is the pairing screen's job, so it gets no notice of its own.
      const local = loadLayout(getBrowserStorage())
      dispatch({ type: 'loaded', layout: local.layout, savedJson: local.savedJson })
      setLoadProblem(r.status === 401 ? null : 'server-unreachable')
      setPhase('offline')
    })
    return () => controller.abort()
  }, [api, attempt])

  // Retry only when the connection comes back; a timer would write an audit record for every 401.
  const wasConnected = useRef(connected)
  useEffect(() => {
    const came = connected && !wasConnected.current
    wasConnected.current = connected
    if (api && came && phaseRef.current === 'offline') {
      setPhase('loading')
      setLoadProblem(null)
      setAttempt((n) => n + 1)
    }
  }, [api, connected])

  const save = useCallback((): Promise<boolean> => {
    if (phaseRef.current !== 'ready') return Promise.resolve(false)
    const snapshot = layoutRef.current
    // Saves run one after another, so a slow earlier request can't land after a later one.
    const run = async () => {
      const result = api ? await saveToServer(api, snapshot) : saveLayout(getBrowserStorage(), snapshot)
      if (result.ok) {
        // The json of what was sent, so edits made while saving still read as unsaved.
        dispatch({ type: 'saved', json: result.json })
        setSaveError(null)
        return true
      }
      setSaveError(result.error)
      return false
    }
    const next = saves.current.then(run)
    saves.current = next.catch(() => undefined)
    return next
  }, [api])

  const resetToDefault = useCallback(() => dispatch({ type: 'replace', layout: createDefaultLayout() }), [])
  const discardToSaved = useCallback(() => dispatch({ type: 'replace', layout: savedLayout(state.savedJson) ?? createDefaultLayout() }), [state.savedJson])

  return {
    state,
    dispatch,
    status: saveStatus(state, saveError !== null),
    saveError,
    loadProblem,
    phase,
    dismissLoadProblem: () => setLoadProblem(null),
    save,
    resetToDefault,
    discardToSaved,
  }
}
