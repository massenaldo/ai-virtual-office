import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from './defaultLayout'
import { createEditorState, isDirty } from './history'
import { LAYOUT_BACKUP_KEY, LAYOUT_STORAGE_KEY, loadLayout, migrateLayout, parseLayout, saveLayout, serializeLayout } from './storage'

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

describe('room rotation', () => {
  const withoutRoomRotation = () => {
    const raw = JSON.parse(serializeLayout(createDefaultLayout()))
    raw.rooms.forEach((r: Record<string, unknown>) => delete r.rotation)
    return raw
  }

  it('round-trips room rotation', () => {
    const l = createDefaultLayout()
    l.rooms[0] = { ...l.rooms[0], rotation: 90 }
    expect(parseLayout(JSON.parse(serializeLayout(l)))?.rooms[0].rotation).toBe(90)
  })

  it('treats a missing room rotation as 0', () => {
    const loaded = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(withoutRoomRotation()) }))
    expect(loaded.problem).toBeNull()
    expect(loaded.layout.rooms.every((r) => r.rotation === 0)).toBe(true)
  })

  it('rejects a room rotation that is not a quarter turn', () => {
    const raw = JSON.parse(serializeLayout(createDefaultLayout()))
    raw.rooms[0].rotation = 45
    expect(parseLayout(raw)).toBeNull()
  })

  it('an old save without room rotation loads clean', () => {
    const loaded = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(withoutRoomRotation()) }))
    expect(isDirty(createEditorState(loaded.layout, loaded.savedJson))).toBe(false)
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
    expect(loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...valid(), schemaVersion: 3 }) })).problem).toBe('unsupported-version')
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

describe('parseLayout inherited names', () => {
  const withRoom = (department: string) => { const l = JSON.parse(serializeLayout(createDefaultLayout())); l.rooms[0].department = department; return l }
  const withFurniture = (type: string) => { const l = JSON.parse(serializeLayout(createDefaultLayout())); l.furniture[0].type = type; return l }
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('rejects %s as a department', (name) => {
    expect(parseLayout(withRoom(name))).toBeNull()
  })
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('rejects %s as a furniture type', (name) => {
    expect(parseLayout(withFurniture(name))).toBeNull()
  })
})

describe('schema 1 upgrade', () => {
  const isBreakRoom = (d: string) => d === 'kitchen' || d === 'dining' || d === 'prayer'
  /** The default office as saved before break areas existed. */
  const v1 = () => {
    const l = createDefaultLayout()
    const ids = new Set(l.rooms.filter((r) => isBreakRoom(r.department)).map((r) => r.id))
    const rooms = l.rooms.filter((r) => !ids.has(r.id))
    const furniture = l.furniture.filter((f) => !f.roomId || !ids.has(f.roomId))
    return { ...JSON.parse(serializeLayout({ ...l, rooms, furniture })), schemaVersion: 1 }
  }
  const room = (id: string, x: number, z: number, width: number, depth: number) => ({ id, name: id, department: 'executive', x, z, width, depth, wallHeight: 2.5, color: '#999999', rotation: 0 })

  it('an unedited schema 1 office gains all three rooms and moves nothing', () => {
    const raw = v1()
    const { layout, problem } = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(raw) }))
    expect(problem).toBeNull()
    expect(layout.schemaVersion).toBe(2)
    expect(layout.rooms.slice(0, raw.rooms.length)).toEqual(raw.rooms)
    expect(layout.furniture.slice(0, raw.furniture.length)).toEqual(raw.furniture)
    expect(layout.rooms.slice(raw.rooms.length).map((r) => r.department)).toEqual(['prayer', 'kitchen', 'dining'])
    expect(serializeLayout(layout)).toBe(serializeLayout(createDefaultLayout()))
  })

  it('a schema 1 office where they do not fit loads exactly as saved, at schema 2', () => {
    const raw = { schemaVersion: 1, office: { width: 10, depth: 10, gridSize: 0.25 }, rooms: [room('room-a', -2.5, -2.5, 5, 5), room('room-b', 2.5, -2.5, 5, 5), room('room-c', -2.5, 2.5, 5, 5), room('room-d', 2.5, 2.5, 5, 5)], furniture: [] }
    const { layout, problem } = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(raw) }))
    expect(problem).toBeNull()
    expect(layout).toEqual({ ...raw, schemaVersion: 2 })
  })

  it('a schema 2 layout with no break rooms is not given them', () => {
    const l = createDefaultLayout()
    const stripped = { ...l, rooms: l.rooms.filter((r) => !isBreakRoom(r.department)), furniture: l.furniture.filter((f) => !f.roomId?.match(/prayer|kitchen|dining/)) }
    const loaded = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: serializeLayout(stripped) }))
    expect(loaded.problem).toBeNull()
    expect(loaded.layout.rooms).toHaveLength(10)
    expect(migrateLayout(stripped)).toBe(stripped)
  })

  it('a damaged schema 1 layout still reads as corrupt', () => {
    const broken = v1()
    delete broken.rooms[0].width
    const result = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(broken) }))
    expect(result.problem).toBe('corrupt')
    expect(result.layout).toEqual(createDefaultLayout())
    expect(migrateLayout(broken)).toBe(broken)
  })

  it('a schema 3 layout is unsupported', () => {
    expect(loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...v1(), schemaVersion: 3 }) })).problem).toBe('unsupported-version')
  })

  it('an upgraded layout loads with no unsaved changes', () => {
    const loaded = loadLayout(memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(v1()) }))
    expect(isDirty(createEditorState(loaded.layout, loaded.savedJson))).toBe(false)
  })

  it('the upgrade does not write anything on load', () => {
    const s = memoryStorage({ [LAYOUT_STORAGE_KEY]: JSON.stringify(v1()) })
    const before = s.data.get(LAYOUT_STORAGE_KEY)
    loadLayout(s)
    expect(s.data.get(LAYOUT_STORAGE_KEY)).toBe(before)
  })

  it('migrateLayout never throws on arbitrary input and passes it through', () => {
    for (const v of [null, undefined, 5, 'x', [], {}, { schemaVersion: 1 }, { schemaVersion: 1, office: 3, rooms: 'x', furniture: null }, { schemaVersion: 1, rooms: [null], furniture: [1], office: {} }]) {
      expect(() => migrateLayout(v)).not.toThrow()
      expect(migrateLayout(v)).toBe(v)
    }
  })

  it('migrating twice gives the same result', () => {
    const once = migrateLayout(v1())
    expect(JSON.stringify(migrateLayout(v1()))).toBe(JSON.stringify(once))
    expect(migrateLayout(once)).toBe(once)
  })
})
