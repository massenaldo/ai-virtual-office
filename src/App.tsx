import { useMemo, useState } from 'react'
import { AlertTriangle, Bot, Boxes, Building2, CheckCircle2, ChevronDown, CircleHelp, Code2, LayoutGrid, Maximize2, Save, Settings2, Users, X } from 'lucide-react'
import OfficeScene from './scene/OfficeScene'
import { canRedo, canUndo } from './layout/history'
import { findIssues } from './layout/validation'
import ConfirmDialog from './editor/ConfirmDialog'
import EditorToolbar from './editor/EditorToolbar'
import OutlinerPanel from './editor/OutlinerPanel'
import PropertiesPanel from './editor/PropertiesPanel'
import { useEditorShortcuts } from './editor/shortcuts'
import { summarizeLayout } from './editor/summary'
import { useEditorActions, type DialogRequest } from './editor/useEditorActions'
import { useLayoutEditor } from './editor/useLayoutEditor'

const LOAD_PROBLEM_MESSAGE = {
  corrupt: "Your saved layout couldn't be loaded, so the default layout is shown. The saved data is kept and backed up before your next save.",
  'unsupported-version': 'Your saved layout comes from a newer version of the app, so the default layout is shown. The saved data is kept and backed up before your next save.',
  unavailable: 'Browser storage is unavailable, so layout changes cannot be saved in this window.',
  missing: '',
}

export default function App() {
  const editor = useLayoutEditor()
  const { state, dispatch } = editor
  const [floorPlan, setFloorPlan] = useState(false)
  const [showTeams, setShowTeams] = useState(true)
  const [viewKey, setViewKey] = useState(0)
  const [editing, setEditing] = useState(false)
  const [snap, setSnap] = useState(true)
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const summary = summarizeLayout(state.layout)
  const issues = useMemo(() => findIssues(state.layout), [state.layout])
  const actions = useEditorActions(editor, setDialog, snap)

  const undo = () => dispatch({ type: 'undo' })
  const redo = () => dispatch({ type: 'redo' })
  const confirmResetLayout = () => setDialog({
    title: 'Reset to the default layout?',
    message: 'This replaces the current rooms and furniture with the default office. You can undo it until you leave the page.',
    actions: [{ label: 'Reset layout', tone: 'danger', onClick: editor.resetToDefault }],
  })
  useEditorShortcuts(editing && !dialog, { undo, redo, delete: actions.requestDelete, escape: actions.escape })

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><strong>AI WORKSPACE</strong><span>VIRTUAL OFFICE</span></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <button className="nav-item active"><Building2 size={17}/> Office</button>
      <button className="nav-item" onClick={() => setShowTeams(!showTeams)}><Users size={17}/> Departments <ChevronDown size={14} className="nav-end"/></button>
      {showTeams && <div className="team-list">{summary.departments.map((d) => <div className="team-item" key={d.id}><span className="team-dot" style={{ background: d.color }}/><span>{d.label}</span><small>{d.desks}</small></div>)}</div>}
      <div className="workspace-label second">COMING NEXT</div>
      <div className="nav-item muted"><Bot size={17}/> AI Agents <span className="soon">LATER</span></div>
      <div className="nav-item muted"><Code2 size={17}/> Engineering</div>
      <div className="nav-item muted"><LayoutGrid size={17}/> Tasks & Projects</div>
      <div className="sidebar-bottom"><div className="local-pill"><span/> Running locally</div><div className="user-row"><div className="avatar">CEO</div><div><strong>Office Owner</strong><small>Administrator</small></div><Settings2 size={16}/></div></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="breadcrumbs">Workspace <span>/</span> <strong>Office Designer</strong></div><div className="top-actions"><span className="save-status"><span className="status-dot"/> Local workspace</span><button className="icon-button" title="Help"><CircleHelp size={18}/></button></div></header>
      <section className="page-heading"><div><div className="eyebrow">YOUR DIGITAL HEADQUARTERS</div><h1>Office Designer</h1><p>Shape the place where your AI engineering team will work.</p></div><button className="primary-button" onClick={editor.save} disabled={editor.status === 'saved'}><Save size={16}/>{editor.status === 'saved' ? 'Saved' : 'Save layout'}</button></section>
      <section className={editing ? 'scene-card editing' : 'scene-card'}><div className="scene-toolbar"><div className="scene-title"><span className="live-dot"/><strong>HQ — Main Office</strong><span className="scene-separator">/</span><span>{floorPlan ? 'Floor plan' : '3D overview'}{editing && ' · Editing'}</span></div>
        <EditorToolbar editing={editing} floorPlan={floorPlan} snap={snap} canUndo={canUndo(state)} canRedo={canRedo(state)} status={editor.status}
          onToggleEditing={() => { setEditing(!editing); actions.select(null) }} onFloorPlan={setFloorPlan} onToggleSnap={() => setSnap(!snap)} onUndo={undo} onRedo={redo}
          onSave={editor.save} onResetLayout={confirmResetLayout} onResetView={() => setViewKey((k) => k + 1)}/></div>
        <div className="editor-body">
        {editing && <OutlinerPanel layout={state.layout} selection={state.selection} issues={issues} onSelect={actions.select} onAddRoom={actions.addRoom} onAddFurniture={actions.addFurniture}/>}
        <div className="canvas-wrap"><OfficeScene layout={state.layout} floorPlan={floorPlan} viewKey={viewKey} editing={editing} selection={state.selection} issues={issues} onSelect={actions.select} onTransformStart={actions.transformStart} onTransform={actions.transform} onTransformEnd={actions.transformEnd}/>
          {editor.loadProblem && <div className="scene-notice" role="alert"><AlertTriangle size={15}/><span>{LOAD_PROBLEM_MESSAGE[editor.loadProblem]}</span><button className="notice-close" onClick={editor.dismissLoadProblem} aria-label="Dismiss"><X size={14}/></button></div>}
          {editor.status === 'save-failed' && <div className="scene-notice error" role="alert"><AlertTriangle size={15}/><span>Save failed: {editor.saveError} Your changes are still here; try saving again.</span></div>}
          <div className="scene-hint"><Maximize2 size={13}/> {editing ? <>Click to select <span>·</span> Drag to move <span>·</span> Drag empty space to {floorPlan ? 'pan' : 'orbit'}</> : <>Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Right-drag to pan</>}</div><div className="scene-badge"><span className="badge-icon"><Building2 size={16}/></span><div><strong>AI Software Company</strong><small>Realistic 3D workspace</small></div></div></div>
        {editing && <PropertiesPanel layout={state.layout} selection={state.selection} issues={issues} onRoomChange={actions.roomChange} onFurnitureChange={actions.furnitureChange} onRotate={actions.rotate} onDuplicate={actions.duplicate} onDelete={actions.requestDelete}/>}
        </div>
        <div className="scene-footer"><div className="legend"><span className="legend-swatch"/><span>Office departments</span><span className="legend-glass"/><span>Glass partitions</span></div><span className="scene-footer-right"><CheckCircle2 size={14}/> {summary.roomCount} rooms · {state.layout.furniture.length} furniture items</span></div>
      </section>
      <section className="bottom-grid"><div className="info-card"><div className="card-icon purple"><Building2 size={18}/></div><div><span className="card-label">OFFICE AREAS</span><strong>{summary.roomCount} <small>rooms</small></strong><p>Departments, meeting rooms, and shared areas.</p></div></div><div className="info-card"><div className="card-icon blue"><Users size={18}/></div><div><span className="card-label">TEAM CAPACITY</span><strong>{summary.deskCount} <small>desks</small></strong><p>Seating plan for your engineering team.</p></div></div><div className="info-card"><div className="card-icon amber"><Settings2 size={18}/></div><div><span className="card-label">NEXT MILESTONE</span><strong>Layout editor</strong><p>Editable rooms, furniture placement, and saved geometry.</p></div></div></section>
      <footer className="page-footer"><span>AI Virtual Office <span className="footer-sep">·</span> Local prototype v0.1.0</span><span>Designed for your team, built by you.</span></footer>
    </section>
    <ConfirmDialog open={!!dialog} title={dialog?.title ?? ''} message={dialog?.message ?? ''} actions={dialog?.actions ?? []} onClose={() => setDialog(null)}/>
  </main>
}
