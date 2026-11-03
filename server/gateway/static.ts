import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'

// Serves the built app (dist/). Paths are checked twice: the raw URL is refused if it contains anything that could climb
// out (dot segments, encoded dots or slashes, backslashes, NUL), and the resolved real path must stay inside the real root,
// which also stops a symlink inside the root from leading out.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const notFound = (res: ServerResponse) => {
  res.statusCode = 404
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end('Not found.')
}

/** The path under the root as a list of segments, or null for anything that is not a plain path. */
function safeSegments(url: string): string[] | null {
  const raw = url.split('?')[0].split('#')[0]
  if (!raw.startsWith('/') || raw.includes('\\') || raw.includes('\0') || raw.includes('..') || /%(2e|2f|5c|00)/i.test(raw)) return null
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('..')) return null
  return decoded.split('/').filter((s) => s !== '' && s !== '.')
}

export function createStaticHandler(opts: { root: string }): (req: IncomingMessage, res: ServerResponse) => boolean {
  const rootReal = realpath(opts.root)

  /** The real path of a regular file inside the root, or null. */
  async function resolveFile(segments: string[]): Promise<string | null> {
    const root = await rootReal
    try {
      const real = await realpath(join(root, ...segments))
      if (real !== root && !real.startsWith(root + sep)) return null
      return (await stat(real)).isFile() ? real : null
    } catch {
      return null
    }
  }

  async function serve(req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> {
    let file = await resolveFile(segments.length === 0 ? ['index.html'] : segments)
    // A route of the single-page app (no extension, no such file) gets the app shell; a missing asset stays a 404.
    if (file === null && extname(segments[segments.length - 1] ?? '') === '') file = await resolveFile(['index.html'])
    if (file === null) return notFound(res)
    const size = (await stat(file)).size
    res.statusCode = 200
    res.setHeader('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
    res.setHeader('content-length', String(size))
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method === 'HEAD') return void res.end()
    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const segments = safeSegments(req.url ?? '/')
    if (segments === null) { notFound(res); return true }
    serve(req, res, segments).catch(() => { if (!res.headersSent) notFound(res); else res.destroy() })
    return true
  }
}
