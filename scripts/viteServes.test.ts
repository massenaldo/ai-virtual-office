import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

// The dev server serves every file under the project root. The data folder holds the API token, the audit log and the
// whole workforce state, so none of it may ever be served over HTTP (it would bypass the token entirely).

const DATA = resolve('data')
const FILES = ['api-token', 'audit.log', 'workforce.json', 'zz-serve-probe.txt']
let vite: ViteDevServer
let port = 0
const created: string[] = []

const get = (path: string, host?: string): Promise<number> =>
  new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port, path: encodeURI(path), headers: host ? { host } : {} }, (res) => { res.resume(); done(res.statusCode ?? 0) })
    req.on('error', fail)
    req.end()
  })

beforeAll(async () => {
  mkdirSync(DATA, { recursive: true })
  // Only files this test created are removed afterwards; a real data folder's files stay.
  for (const f of FILES) { try { writeFileSync(resolve(DATA, f), 'probe', { flag: 'wx' }); created.push(f) } catch { /* already there: serve-check it as is */ } }
  vite = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'silent', server: { port: 0, strictPort: false } })
  await vite.listen()
  port = (vite.httpServer!.address() as AddressInfo).port
})
afterAll(async () => {
  await vite.close()
  for (const f of created) rmSync(resolve(DATA, f), { force: true })
})

describe('what the Vite dev server will serve', () => {
  it.each(FILES)('refuses /data/%s in every form', async (file) => {
    for (const path of [`/data/${file}`, `/data/${file}?raw`, `/@fs${resolve(DATA, file)}`, `/@fs/${resolve(DATA, file)}`]) expect([403, 404], path).toContain(await get(path))
  })

  it('still serves the app', async () => {
    expect(await get('/')).toBe(200)
  })

  it('refuses a foreign Host header', async () => {
    expect(await get('/', 'evil.example')).toBe(403)
  })
})
