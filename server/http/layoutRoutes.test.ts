import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../src/layout/defaultLayout'
import { updateFurniture } from '../../src/layout/operations'
import { serializeLayout } from '../../src/layout/storage'
import { LAYOUT_FILE } from '../layoutStore'
import { startServer } from '../app'
import { silentLogger } from '../log'
import { rawRequest, startTestServer, tempDataDir, testConfig, type TestServer } from '../test/helpers'

let s: TestServer | undefined
afterEach(async () => { await s?.close(); s = undefined })

const edited = () => updateFurniture(createDefaultLayout(), 'plant-01', { x: 5 })

describe('/api/layout', () => {
  it('GET with nothing saved is empty and writes nothing', async () => {
    s = await startTestServer()
    expect(await s.api('GET', '/api/layout')).toMatchObject({ status: 200, body: { layout: null, loadProblem: null } })
    expect(existsSync(join(s.dataDir, LAYOUT_FILE))).toBe(false)
  })

  it('PUT then GET returns the layout and stores the normalised form', async () => {
    s = await startTestServer()
    const raw = JSON.parse(serializeLayout(edited()))
    raw.extra = 'ignored'
    raw.rooms[0].extra = 'ignored'
    expect(await s.api('PUT', '/api/layout', { layout: raw })).toMatchObject({ status: 200, body: { ok: true } })
    expect((await s.api('GET', '/api/layout')).body).toEqual({ layout: edited(), loadProblem: null })
    expect(readFileSync(join(s.dataDir, LAYOUT_FILE), 'utf8')).toBe(serializeLayout(edited()))
  })

  it.each([
    ['missing layout', {}],
    ['not a layout', { layout: { nope: true } }],
    ['wrong schema version', { layout: { ...JSON.parse(serializeLayout(createDefaultLayout())), schemaVersion: 3 } }],
  ])('PUT %s is 422', async (_name, body) => {
    s = await startTestServer()
    const r = await s.api('PUT', '/api/layout', body)
    expect(r.status).toBe(422)
    expect(existsSync(join(s.dataDir, LAYOUT_FILE))).toBe(false)
  })

  it('PUT with an inherited department name is 422', async () => {
    s = await startTestServer()
    const layout = JSON.parse(serializeLayout(createDefaultLayout()))
    layout.rooms[0].department = 'constructor'
    expect((await s.api('PUT', '/api/layout', { layout })).status).toBe(422)
  })

  it('PUT with an unknown field is 400', async () => {
    s = await startTestServer()
    expect((await s.api('PUT', '/api/layout', { layout: createDefaultLayout(), path: '/etc' })).status).toBe(400)
  })

  it('PUT over 512 KB is 413, but a body over 64 KB is accepted', async () => {
    s = await startTestServer()
    const big = (rooms: number) => {
      const l = JSON.parse(serializeLayout(createDefaultLayout()))
      const room = l.rooms[0]
      for (let i = 0; i < rooms; i++) l.rooms.push({ ...room, id: `room-extra-${i}`, name: 'x'.repeat(100) })
      return l
    }
    const mid = JSON.stringify({ layout: big(700) })
    expect(mid.length).toBeGreaterThan(65536)
    expect(mid.length).toBeLessThan(524288)
    expect((await s.api('PUT', '/api/layout', { layout: big(700) })).status).toBe(200)
    // The server answers and closes while the client may still be sending, so a busy machine can see the reset instead.
    const refused = await s.api('PUT', '/api/layout', { layout: big(4000) }).then((r) => r.status, (e: { cause?: { code?: string } }) => e.cause?.code)
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(refused)
    const kept = (await s.api('GET', '/api/layout')).body as { layout: { rooms: unknown[] } }
    expect(kept.layout.rooms).toHaveLength(createDefaultLayout().rooms.length + 700)
  })

  it('is refused without credentials', async () => {
    s = await startTestServer()
    expect((await rawRequest(s.url, { path: '/api/layout', noAuth: true })).status).toBe(401)
    expect((await rawRequest(s.url, { method: 'PUT', path: '/api/layout', noAuth: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: createDefaultLayout() }) })).status).toBe(401)
  })

  it('a write failure is 500 with a fixed sentence and no path', async () => {
    s = await startTestServer({}, { storeWriteFile: (path, text) => { if (path.endsWith(LAYOUT_FILE)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' }); writeFileSync(path, text) } })
    const r = await s.api('PUT', '/api/layout', { layout: createDefaultLayout() })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain(s.dataDir)
    expect(r.body.error).toBe('Permission denied (EACCES).')
  })

  it('survives a restart on the same data dir', async () => {
    const dir = tempDataDir()
    try {
      // Not startTestServer: its close() removes the data dir, and this test needs it to outlive the first server.
      const first = await startServer(testConfig({ DATA_DIR: dir }), { log: silentLogger })
      const put = await fetch(`${first.url}/api/layout`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.app.apiToken.value}` }, body: JSON.stringify({ layout: edited() }) })
      expect(put.status).toBe(200)
      await first.close()
      s = await startTestServer({ DATA_DIR: dir })
      expect((await s.api('GET', '/api/layout')).body).toEqual({ layout: edited(), loadProblem: null })
    } finally {
      await s?.close(); s = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a damaged file until a save replaces it', async () => {
    const dir = tempDataDir()
    writeFileSync(join(dir, LAYOUT_FILE), '{nope')
    try {
      s = await startTestServer({ DATA_DIR: dir })
      expect((await s.api('GET', '/api/layout')).body).toEqual({ layout: null, loadProblem: 'corrupt' })
      await s.api('PUT', '/api/layout', { layout: edited() })
      expect((await s.api('GET', '/api/layout')).body).toEqual({ layout: edited(), loadProblem: null })
    } finally {
      await s?.close(); s = undefined
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
