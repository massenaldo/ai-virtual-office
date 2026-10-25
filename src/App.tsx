import { useState } from 'react'
import { Bot, Boxes, Building2, CheckCircle2, ChevronDown, CircleHelp, Code2, LayoutGrid, Maximize2, RotateCcw, Save, Settings2, Users, ZoomIn } from 'lucide-react'
import OfficeScene from './scene/OfficeScene'
import { createDefaultLayout } from './layout/defaultLayout'

const departments = [
  { name: 'Project Management', count: 2, color: '#d3b58a' },
  { name: 'Tech Lead', count: 1, color: '#9db7c1' },
  { name: 'Backend Engineering', count: 4, color: '#7fa0ae' },
  { name: 'Frontend Engineering', count: 4, color: '#91b2bc' },
  { name: 'Data & Database', count: 2, color: '#78949f' },
  { name: 'UI/UX Design', count: 2, color: '#c8a58a' },
  { name: 'QA Testing', count: 3, color: '#b7a4a0' },
  { name: 'DevOps', count: 1, color: '#77838c' },
]

export default function App() {
  const [floorPlan, setFloorPlan] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showTeams, setShowTeams] = useState(true)
  const [layout] = useState(createDefaultLayout)
  const [viewKey, setViewKey] = useState(0)
  const saveLayout = () => {
    localStorage.setItem('ai-virtual-office-layout', JSON.stringify({ version: 1, view: floorPlan ? 'floor-plan' : '3d', savedAt: new Date().toISOString() }))
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }
  const resetView = () => setViewKey((k) => k + 1)
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><strong>AI WORKSPACE</strong><span>VIRTUAL OFFICE</span></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <button className="nav-item active"><Building2 size={17}/> Office</button>
      <button className="nav-item" onClick={() => setShowTeams(!showTeams)}><Users size={17}/> Departments <ChevronDown size={14} className="nav-end"/></button>
      {showTeams && <div className="team-list">{departments.map((d) => <div className="team-item" key={d.name}><span className="team-dot" style={{ background: d.color }}/><span>{d.name}</span><small>{d.count}</small></div>)}</div>}
      <div className="workspace-label second">COMING NEXT</div>
      <div className="nav-item muted"><Bot size={17}/> AI Agents <span className="soon">LATER</span></div>
      <div className="nav-item muted"><Code2 size={17}/> Engineering</div>
      <div className="nav-item muted"><LayoutGrid size={17}/> Tasks & Projects</div>
      <div className="sidebar-bottom"><div className="local-pill"><span/> Running locally</div><div className="user-row"><div className="avatar">CEO</div><div><strong>Office Owner</strong><small>Administrator</small></div><Settings2 size={16}/></div></div>
    </aside>
    <section className="main-area">
      <header className="topbar"><div className="breadcrumbs">Workspace <span>/</span> <strong>Office Designer</strong></div><div className="top-actions"><span className="save-status"><span className="status-dot"/> Local workspace</span><button className="icon-button" title="Help"><CircleHelp size={18}/></button></div></header>
      <section className="page-heading"><div><div className="eyebrow">YOUR DIGITAL HEADQUARTERS</div><h1>Office Designer</h1><p>Shape the place where your AI engineering team will work.</p></div><button className="primary-button" onClick={saveLayout}><Save size={16}/>{saved ? 'Saved locally' : 'Save layout'}</button></section>
      <section className="scene-card"><div className="scene-toolbar"><div className="scene-title"><span className="live-dot"/><strong>HQ — Main Office</strong><span className="scene-separator">/</span><span>{floorPlan ? 'Floor plan' : '3D overview'}</span></div><div className="scene-controls"><button className={!floorPlan ? 'view-button selected' : 'view-button'} onClick={() => setFloorPlan(false)}><Boxes size={15}/> 3D view</button><button className={floorPlan ? 'view-button selected' : 'view-button'} onClick={() => setFloorPlan(true)}><LayoutGrid size={15}/> Floor plan</button><button className="view-button" onClick={resetView}><RotateCcw size={15}/><span className="reset-label">Reset view</span></button><button className="square-button" title="Zoom controls are available with your mouse"><ZoomIn size={16}/></button></div></div>
        <div className="canvas-wrap"><OfficeScene layout={layout} floorPlan={floorPlan} viewKey={viewKey}/><div className="scene-hint"><Maximize2 size={13}/> Drag to orbit <span>·</span> Scroll to zoom <span>·</span> Right-drag to pan</div><div className="scene-badge"><span className="badge-icon"><Building2 size={16}/></span><div><strong>AI Software Company</strong><small>Realistic 3D workspace</small></div></div></div>
        <div className="scene-footer"><div className="legend"><span className="legend-swatch"/><span>Office departments</span><span className="legend-glass"/><span>Glass partitions</span></div><span className="scene-footer-right"><CheckCircle2 size={14}/> Prototype scene</span></div>
      </section>
      <section className="bottom-grid"><div className="info-card"><div className="card-icon purple"><Building2 size={18}/></div><div><span className="card-label">OFFICE AREAS</span><strong>10 <small>planned spaces</small></strong><p>Departments, meeting rooms, and shared areas.</p></div></div><div className="info-card"><div className="card-icon blue"><Users size={18}/></div><div><span className="card-label">TEAM CAPACITY</span><strong>19 <small>planned desks</small></strong><p>Initial seating plan for your engineering team.</p></div></div><div className="info-card"><div className="card-icon amber"><Settings2 size={18}/></div><div><span className="card-label">NEXT MILESTONE</span><strong>Layout editor</strong><p>Editable rooms, furniture placement, and saved geometry.</p></div></div></section>
      <footer className="page-footer"><span>AI Virtual Office <span className="footer-sep">·</span> Local prototype v0.1.0</span><span>Designed for your team, built by you.</span></footer>
    </section>
  </main>
}
