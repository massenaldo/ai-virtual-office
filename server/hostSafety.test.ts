import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from './config'
import { checkHost, enforceHostSafety, readHostFacts, type HostFacts } from './hostSafety'
import { recordingLogger } from './log'

const base: HostFacts = { runtime: 'claude', uid: 1000, allowRoot: false, dataDir: '/srv/vo/data', dataDirMode: 0o700, projectDir: '/srv/vo/app', workspaces: [{ id: 'sandbox', path: '/srv/vo/workspaces/sandbox' }], homeCredentials: [] }

describe('checkHost', () => {
  it('has nothing to say about a dedicated user with a private data folder and a separate workspace', () => {
    expect(checkHost(base)).toEqual({ refuse: [], warn: [] })
  })
  it('says nothing at all for the mock runtime, whatever the setup', () => {
    expect(checkHost({ ...base, runtime: 'mock', uid: 0, dataDirMode: 0o777, homeCredentials: ['.ssh'], workspaces: [{ id: 'all', path: '/' }] })).toEqual({ refuse: [], warn: [] })
  })

  it('refuses to run the claude runtime as root, unless the owner said they accept it', () => {
    expect(checkHost({ ...base, uid: 0 }).refuse).toEqual([expect.stringContaining('as root')])
    expect(checkHost({ ...base, uid: 0, allowRoot: true }).refuse).toEqual([])
  })

  it.each([
    ['equals the project folder', '/srv/vo/app'],
    ['is a parent of the project folder', '/srv/vo'],
    ['is the filesystem root', '/'],
  ])('refuses a workspace that %s, because the agent could then change the server code', (_n, path) => {
    const r = checkHost({ ...base, workspaces: [{ id: 'big', path }] })
    expect(r.refuse).toEqual([expect.stringContaining('Workspace "big" contains the application')])
  })
  it('accepts a workspace inside the project folder or next to it', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'a', path: '/srv/vo/app/sandbox' }, { id: 'b', path: '/srv/vo/appendix' }] }).refuse).toEqual([])
  })

  it.each([[0o755, '755'], [0o770, '770'], [0o707, '707'], [0o775, '775']])('warns about a data folder with mode %s', (mode, text) => {
    expect(checkHost({ ...base, dataDirMode: mode }).warn).toEqual([expect.stringContaining(`mode ${text}`)])
  })
  it('does not warn about a data folder that does not exist yet', () => {
    expect(checkHost({ ...base, dataDirMode: null }).warn).toEqual([])
  })

  it('warns, with the names, when the server user keeps credentials in its home', () => {
    expect(checkHost({ ...base, homeCredentials: ['.ssh', '.aws'] }).warn).toEqual([expect.stringContaining('.ssh, .aws')])
  })
  it('reports every problem at once', () => {
    const r = checkHost({ ...base, uid: 0, dataDirMode: 0o777, workspaces: [{ id: 'big', path: '/' }] })
    expect(r.refuse).toHaveLength(2)
    expect(r.warn).toHaveLength(1)
  })
})

describe('reading the facts and enforcing them', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
  const setup = (env: Record<string, string>, mode = 0o700) => {
    dir = mkdtempSync(join(tmpdir(), 'vo-host-'))
    const root = join(dir, 'ws'); mkdirSync(join(root, 'sandbox'), { recursive: true })
    const data = join(dir, 'data'); mkdirSync(data); chmodSync(data, mode)
    const home = join(dir, 'home'); mkdirSync(home)
    const parsed = parseConfig({ RUNTIME: 'claude', ANTHROPIC_API_KEY: 'k'.repeat(20), DATA_DIR: data, WORKSPACE_ROOT: root, WORKSPACES: 'sandbox:sandbox', ...env }, dir)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    return { config: parsed.config, home, root, data }
  }

  it('reads the user, the data folder mode, the real workspace path and the credentials in the home folder', () => {
    const s = setup({})
    mkdirSync(join(s.home, '.ssh')); writeFileSync(join(s.home, '.netrc'), 'x')
    const facts = readHostFacts(s.config, { HOME: s.home }, join(dir, 'app'))
    expect(facts).toMatchObject({ runtime: 'claude', allowRoot: false, dataDirMode: 0o700, homeCredentials: ['.ssh', '.netrc'] })
    expect(facts.workspaces).toEqual([{ id: 'sandbox', path: expect.stringContaining('sandbox') }])
    expect(facts.uid === null || typeof facts.uid === 'number').toBe(true)
  })
  it('reads VO_ALLOW_ROOT only when it is exactly "yes"', () => {
    const s = setup({})
    expect(readHostFacts(s.config, { HOME: s.home, VO_ALLOW_ROOT: 'yes' }, dir).allowRoot).toBe(true)
    expect(readHostFacts(s.config, { HOME: s.home, VO_ALLOW_ROOT: 'true' }, dir).allowRoot).toBe(false)
  })
  it('lets a safe setup start and logs a warning for an open data folder', () => {
    const s = setup({}, 0o755)
    const log = recordingLogger()
    expect(enforceHostSafety(s.config, log, { HOME: s.home }, join(dir, 'app'))).toBe(true)
    expect(log.lines.join('\n')).toContain('mode 755')
  })
  it('stops a setup whose workspace contains the application folder', () => {
    const s = setup({})
    const log = recordingLogger()
    expect(enforceHostSafety(s.config, log, { HOME: s.home }, join(s.root, 'sandbox'))).toBe(false)
    expect(log.lines.join('\n')).toContain('contains the application')
  })
  it('does nothing for the mock runtime', () => {
    const s = setup({ RUNTIME: 'mock' }, 0o777)
    const log = recordingLogger()
    expect(enforceHostSafety(s.config, log, { HOME: s.home }, s.root)).toBe(true)
    expect(log.lines).toEqual([])
  })
})
