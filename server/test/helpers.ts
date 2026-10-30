import { mkdtempSync, rmSync } from 'node:fs'
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
      const res = await fetch(`${running.url}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text()
      let parsed: unknown = text
      try { parsed = text === '' ? null : JSON.parse(text) } catch { /* not JSON: keep the text */ }
      return { status: res.status, headers: res.headers, body: parsed }
    },
  }
}
