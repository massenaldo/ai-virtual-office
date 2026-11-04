import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { recordingLogger } from './log'
import { openPermissionStore } from './permissions/store'
import { silentLogger } from './log'
import { FakeProvider } from './test/fakeProvider'
import { testConfig } from './test/helpers'

// At start with RUNTIME=claude, old agent rules that allow writes in every workspace or for every runtime are named once, without paths.
const NOW = () => new Date().toISOString()
let dir: string | null = null
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null })

function boot(runtime: 'mock' | 'claude', seed: boolean) {
  const config = testConfig({ RUNTIME: runtime })
  dir = config.dataDir
  if (seed) {
    const store = openPermissionStore({ dataDir: dir, now: NOW, log: silentLogger })
    expect(store.grant({ scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'agent-demo-backend', createdBy: 'user' }).ok).toBe(true)
    expect(store.grant({ scope: 'agent', effect: 'allow', tool: 'Edit', agentId: 'agent-demo-backend', workspaceId: 'sandbox', runtime: 'claude', createdBy: 'user' }).ok).toBe(true)
    expect(store.grant({ scope: 'agent', effect: 'allow', tool: 'Edit', agentId: 'agent-demo-backend', workspaceId: 'sandbox', createdBy: 'user' }).ok).toBe(true)
  }
  const log = recordingLogger()
  const app = createApp(config, { log, provider: new FakeProvider({ kind: runtime }) })
  app.audit.close()
  app.releaseLock()
  return log.lines.filter((l) => l.startsWith('warn'))
}

describe('unbound write rules at start', () => {
  it('warns once, with the count and no path, for the claude runtime', () => {
    const warns = boot('claude', true)
    expect(warns).toEqual(['warn 2 active agent or task permission rules allow file writes without being limited to one workspace and one runtime (they were made before those limits existed). Review and revoke them in the permissions panel.'])
  })
  it('says nothing without such rules', () => expect(boot('claude', false)).toEqual([]))
  it('says nothing for the mock runtime', () => expect(boot('mock', true)).toEqual([]))
})
