import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { LAYOUT_BACKUP_KEY, LAYOUT_STORAGE_KEY, loadLayout, parseLayout, saveLayout, serializeLayout } from './storage'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const touched: string[] = []
  return {
    data,
    touched,
    getItem: (k: string) => { touched.push(k); return data.get(k) ?? null },
    setItem: (k: string, v: string) => { touched.push(k); data.set(k, v) },
  }
}

describe('saveLayout + loadLayout', () => {
  it('round-trips the full layout', () => {
    const s = memoryStorage()
    const layout = createDefaultLayout()
    const saved = saveLayout(s, layout)
    expect(saved.ok).toBe(true)
    const loaded = loadLayout(s)
    expect(loaded.problem).toBeNull()
    expect(loaded.layout).toEqual(layout)
    expect(loaded.savedJson).toBe(s.data.get(LAYOUT_STORAGE_KEY))
  })

  it('serializes deterministically regardless of key order', () => {
    const l = createDefaultLayout()
    const shuffled = { furniture: l.furniture, rooms: l.rooms, office: l.office, schemaVersion: l.schemaVersion }
    expect(serializeLayout(shuffled)).toBe(serializeLayout(l))
  })
})

describe('loadLayout fallbacks', () => {
  const valid = () => JSON.parse(serializeLayout(createDefaultLayout()))

  it('uses the default layout when nothing is saved', () => {
    expect(loadLayout(memoryStorage())).toMatchObject({ problem: 'missing', savedJson: null })
  })

  it('reports corrupt JSON', () => {
    expect(loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: '{not json' })).problem).toBe('corrupt')
  })

  it('reports a newer schema version as unsupported', () => {
    expect(loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...valid(), schemaVersion: 2 }) })).problem).toBe('unsupported-version')
  })

  it('rejects a partially written layout', () => {
    const broken = valid()
    delete broken.rooms[0].width
    const result = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(broken) }))
    expect(result.problem).toBe('corrupt')
    expect(result.layout).toEqual(createDefaultLayout())
  })

  it('reports unavailable storage', () => {
    expect(loadLayout(null).problem).toBe('unavailable')
  })

  it('never reads or writes the legacy view key', () => {
    const s = memoryStorage({ 'ai-virtual-office-layout': '{"version":1,"view":"3d"}' })
    loadLayout(s)
    saveLayout(s, createDefaultLayout())
    expect(s.touched).not.toContain('ai-virtual-office-layout')
    expect(s.data.get('ai-virtual-office-layout')).toBe('{"version":1,"view":"3d"}')
  })
})

describe('saveLayout safety', () => {
  it('reports a quota error instead of throwing', () => {
    const s = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError') } }
    const result = saveLayout(s, createDefaultLayout())
    expect(result.ok).toBe(false)
  })

  it('backs up an unreadable saved value once before overwriting it', () => {
    const s = memoryStorage({ [LAYOUT_STORAGE_KEY]: '{bad' })
    expect(saveLayout(s, createDefaultLayout()).ok).toBe(true)
    expect(s.data.get(LAYOUT_BACKUP_KEY)).toBe('{bad')
    s.data.set(LAYOUT_STORAGE_KEY, '{also bad')
    saveLayout(s, createDefaultLayout())
    expect(s.data.get(LAYOUT_BACKUP_KEY)).toBe('{bad')
  })

  it('refuses to write an invalid layout', () => {
    const s = memoryStorage()
    const bad = createDefaultLayout()
    bad.rooms[0].x = NaN
    expect(saveLayout(s, bad).ok).toBe(false)
    expect(s.data.has(LAYOUT_STORAGE_KEY)).toBe(false)
  })
})

describe('parseLayout', () => {
  it('rejects duplicate ids and dangling room references', () => {
    const dup = createDefaultLayout()
    dup.furniture[1].id = dup.furniture[0].id
    expect(parseLayout(dup)).toBeNull()
    const dangling = createDefaultLayout()
    dangling.furniture[0].roomId = 'room-nope'
    expect(parseLayout(dangling)).toBeNull()
  })

  it('rejects unknown furniture types and rotations', () => {
    const l = JSON.parse(serializeLayout(createDefaultLayout()))
    l.furniture[0].rotation = 45
    expect(parseLayout(l)).toBeNull()
  })
})

describe('furniture types', () => {
  it('round-trips the new meeting chair, storage cabinet and shelf types', () => {
    const s = memoryStorage()
    const layout = createDefaultLayout()
    layout.furniture.push(
      { id: 'shelf-x', type: 'shelf', x: 0, z: 7, rotation: 90, roomId: null },
      { id: 'mchair-x', type: 'meeting-chair', x: 2, z: 7, rotation: 0, roomId: null },
      { id: 'cabinet-x', type: 'storage-cabinet', x: 4, z: 7, rotation: 180, roomId: null },
    )
    expect(saveLayout(s, layout).ok).toBe(true)
    const loaded = loadLayout(s)
    expect(loaded.problem).toBeNull()
    expect(loaded.layout.furniture.slice(-3).map((f) => f.type)).toEqual(['shelf', 'meeting-chair', 'storage-cabinet'])
  })

  it('still loads layouts saved before the new types existed', () => {
    const s = memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(createDefaultLayout()) })
    expect(loadLayout(s).problem).toBeNull()
  })
})
