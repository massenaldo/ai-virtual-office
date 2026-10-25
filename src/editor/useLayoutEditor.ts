import { useCallback, useReducer, useState, type Dispatch } from 'react'
import { createDefaultLayout } from '../layout/defaultLayout'
import { createEditorState, editorReducer, type EditorAction, type EditorState } from '../layout/history'
import { getBrowserStorage, loadLayout, parseLayout, saveLayout, type LoadProblem } from '../layout/storage'
import { saveStatus, type SaveStatus } from './status'

export type LayoutEditor = {
  state: EditorState
  dispatch: Dispatch<EditorAction>
  status: SaveStatus
  saveError: string | null
  loadProblem: LoadProblem | null
  dismissLoadProblem(): void
  save(): boolean
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

/** Editor state backed by localStorage. Loading happens once, on first render. */
export function useLayoutEditor(): LayoutEditor {
  const [initial] = useState(() => loadLayout(getBrowserStorage()))
  const [state, dispatch] = useReducer(editorReducer, initial, (i) => createEditorState(i.layout, i.savedJson))
  const [saveError, setSaveError] = useState<string | null>(null)
  // Only damaged or newer saved data deserves a notice; "nothing saved yet" is the normal first run.
  const [loadProblem, setLoadProblem] = useState<LoadProblem | null>(initial.problem === 'corrupt' || initial.problem === 'unsupported-version' || initial.problem === 'unavailable' ? initial.problem : null)

  const save = useCallback(() => {
    const result = saveLayout(getBrowserStorage(), state.layout)
    if (result.ok) {
      dispatch({ type: 'saved', json: result.json })
      setSaveError(null)
      return true
    }
    setSaveError(result.error)
    return false
  }, [state.layout])

  const resetToDefault = useCallback(() => dispatch({ type: 'replace', layout: createDefaultLayout() }), [])
  const discardToSaved = useCallback(() => dispatch({ type: 'replace', layout: savedLayout(state.savedJson) ?? createDefaultLayout() }), [state.savedJson])

  return {
    state,
    dispatch,
    status: saveStatus(state, saveError !== null),
    saveError,
    loadProblem,
    dismissLoadProblem: () => setLoadProblem(null),
    save,
    resetToDefault,
    discardToSaved,
  }
}
