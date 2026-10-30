import { mkdtempSync, rmSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type AppDeps, type RunningServer } from '../app'
import { parseConfig, type Env, type ServerConfig } from '../config'
import { silentLogger } from '../log'

export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'vo-server-'))
}

export function testConfig(env: Env = {}): ServerConfig {
  const parsed = parseConfig({ PORT: '0', DATA_DIR: tempDataDir(), ...env })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.config
}

export type TestServer = RunningServer & { dataDir: string; api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }> }

/** Starts the app on a random port with its own data directory; close() also removes that directory. */
export async function startTestServer(env: Env = {}, deps: AppDeps = {}): Promise<TestServer> {
  const config = testConfig(env)
  const running = await startServer(config, { log: silentLogger, ...deps })
  return {
    ...running,
    dataDir: config.dataDir,
    close: async () => { await running.close(); rmSync(config.dataDir, { recursive: true, force: true }) },
    api: async (method, path, body, headers = {}) => {
      const res = await fetch(`${running.url}${path}`, { method, headers: { ...(method === 'GET' || method === 'HEAD' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      let parsed: unknown = text
      try { parsed = text === '' ? null : JSON.parse(text) } catch { /* not JSON: keep the text */ }
      return { status: res.status, headers: res.headers, body: parsed }
    },
  }
}

/** A plain node:http request, so tests can set headers fetch refuses to send (Host) and omit ones it adds (Content-Type). */
export function rawRequest(baseUrl: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.path, baseUrl)
    const req = request({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname + url.search, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

