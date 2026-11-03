import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStaticHandler } from './static'

let base: string
let server: Server
let port: number
const SECRET = 'TOP-SECRET-OUTSIDE'

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'vo-static-'))
  const root = join(base, 'dist')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<html>app</html>')
  writeFileSync(join(root, 'assets', 'x.js'), 'console.log(1)')
  writeFileSync(join(root, 'assets', 'x.css'), 'a{}')
  writeFileSync(join(root, 'data.json'), '{}')
  writeFileSync(join(root, 'logo.svg'), '<svg/>')
  writeFileSync(join(root, 'notes.txt'), 'hi')
  writeFileSync(join(root, 'x.js.map'), '{}')
  writeFileSync(join(root, 'f.woff2'), 'w')
  writeFileSync(join(root, 'p.png'), 'p')
  writeFileSync(join(root, 'p.jpg'), 'j')
  writeFileSync(join(root, 'favicon.ico'), 'i')
  writeFileSync(join(root, 'weird.bin'), 'b')
  writeFileSync(join(base, 'package.json'), SECRET)
  writeFileSync(join(base, 'outside.txt'), SECRET)
  symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'))
  symlinkSync(base, join(root, 'linkdir'))
  const handle = createStaticHandler({ root })
  server = createServer((req, res) => { if (!handle(req, res)) { res.statusCode = 599; res.end('unhandled') } })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  rmSync(base, { recursive: true, force: true })
})

// node:http's client, not fetch: fetch normalises "/../" and "\" before sending, which would hide the attacks.
function raw(method: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('static handler', () => {
  it('serves index.html at /', async () => {
    const r = await raw('GET', '/')
    expect(r.status).toBe(200)
    expect(r.body).toBe('<html>app</html>')
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })

  it('serves a file in a subdirectory and ignores the query string', async () => {
    const r = await raw('GET', '/assets/x.js?v=1')
    expect(r.status).toBe(200)
    expect(r.body).toBe('console.log(1)')
  })

  it('falls back to index.html for a missing path with no extension', async () => {
    const r = await raw('GET', '/office/room/3')
    expect(r.status).toBe(200)
    expect(r.body).toBe('<html>app</html>')
  })

  it('answers 404 for a missing path with an extension', async () => {
    const r = await raw('GET', '/assets/missing.js')
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('<html>')
  })

  it('answers HEAD with headers and no body', async () => {
    const r = await raw('HEAD', '/assets/x.js')
    expect(r.status).toBe(200)
    expect(r.body).toBe('')
    expect(r.headers['content-length']).toBe('14')
  })

  it('leaves other methods unanswered (returns false)', async () => {
    const r = await raw('POST', '/')
    expect(r.status).toBe(599)
    expect(r.body).toBe('unhandled')
  })

  it.each([
    ['/assets/x.js', 'text/javascript; charset=utf-8'],
    ['/assets/x.css', 'text/css; charset=utf-8'],
    ['/data.json', 'application/json; charset=utf-8'],
    ['/logo.svg', 'image/svg+xml'],
    ['/p.png', 'image/png'],
    ['/p.jpg', 'image/jpeg'],
    ['/favicon.ico', 'image/x-icon'],
    ['/f.woff2', 'font/woff2'],
    ['/notes.txt', 'text/plain; charset=utf-8'],
    ['/x.js.map', 'application/json; charset=utf-8'],
    ['/weird.bin', 'application/octet-stream'],
  ])('sets the content type of %s', async (path, type) => {
    const r = await raw('GET', path)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe(type)
  })

  it.each([
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E/package.json',
    '/..%2fpackage.json',
    '/..%2Fpackage.json',
    '/a\\..\\b',
    '/..%5cpackage.json',
    '/assets/..%2f..%2fpackage.json',
    '/%00',
    '/index.html%00.png',
    '/assets/../../package.json',
    '/link.txt',
    '/linkdir/package.json',
    '/linkdir/outside.txt',
  ])('never returns outside content for %s', async (path) => {
    const r = await raw('GET', path)
    expect(r.status).toBe(404)
    expect(r.body).not.toContain(SECRET)
  })

  it('also refuses traversal on HEAD', async () => {
    expect((await raw('HEAD', '/../package.json')).status).toBe(404)
  })

  it('does not serve a directory listing', async () => {
    const r = await raw('GET', '/assets')
    expect(r.body).not.toContain('x.js')
  })

  it('refuses a malformed percent escape', async () => {
    expect((await raw('GET', '/%E0%A4%A')).status).toBe(404)
  })
})
