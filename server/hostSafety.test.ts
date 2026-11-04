import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from './config'
import { checkHost, countUnboundWriteRules, enforceHostSafety, readHostFacts, UNBOUND_WRITE_RULES_WARNING, type HostFacts } from './hostSafety'
import type { PermissionRule } from './permissions/types'
import { recordingLogger } from './log'

const base: HostFacts = { claudeEnabled: true, uid: 1000, allowRoot: false, dataDir: '/srv/vo/data', dataDirMode: 0o700, projectDir: '/srv/vo/app', home: '/home/vo', workspaceRoot: '/srv/vo/workspaces', workspaces: [{ id: 'sandbox', path: '/srv/vo/workspaces/sandbox' }], homeCredentials: [] }

describe('checkHost', () => {
  it('has nothing to say about a dedicated user with a private data folder and a separate workspace', () => {
    expect(checkHost(base)).toEqual({ refuse: [], warn: [] })
  })
  it('says nothing at all when the Claude runtime is not registered, whatever the setup', () => {
    expect(checkHost({ ...base, claudeEnabled: false, uid: 0, dataDirMode: 0o777, homeCredentials: ['.ssh'], workspaces: [{ id: 'all', path: '/' }] })).toEqual({ refuse: [], warn: [] })
  })

  it('refuses to run the claude runtime as root, unless the owner said they accept it', () => {
    expect(checkHost({ ...base, uid: 0 }).refuse).toEqual([expect.stringContaining('Refusing to run the Claude runtime (RUNTIME=claude or ENABLE_CLAUDE_RUNTIME=yes) as root.')])
    expect(checkHost({ ...base, uid: 0, allowRoot: true }).refuse).toEqual([])
  })

  it.each([
    ['equals the project folder', '/srv/vo/app'],
    ['is a parent of the project folder', '/srv/vo'],
    ['is the filesystem root', '/'],
  ])('refuses a workspace that %s, because the agent could then change the server code', (_n, path) => {
    const r = checkHost({ ...base, workspaces: [{ id: 'big', path }] })
    expect(r.refuse[0]).toContain('Workspace "big" contains the application')
  })
  it('accepts a workspace inside the project folder or next to it', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'a', path: '/srv/vo/app/sandbox' }, { id: 'b', path: '/srv/vo/appendix' }] }).refuse).toEqual([])
  })

  it.each([
    ['equals the home folder', '/home/vo'],
    ['is a parent of the home folder', '/home'],
  ])('refuses a workspace that %s', (_n, path) => {
    expect(checkHost({ ...base, workspaces: [{ id: 'h', path }] }).refuse).toEqual([`Workspace "h" contains the server user's home folder, which holds personal files and credentials. Use a folder made for the agent.`])
  })
  it('accepts a workspace inside the home folder', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'h', path: '/home/vo/agent' }] }).refuse).toEqual([])
  })
  it.each([
    ['equal', '/srv/vo/workspaces/a', '/srv/vo/workspaces/a'],
    ['nested', '/srv/vo/workspaces/a', '/srv/vo/workspaces/a/b'],
    ['nested the other way', '/srv/vo/workspaces/a/b', '/srv/vo/workspaces/a'],
  ])('refuses workspaces that are %s', (_n, pa, pb) => {
    expect(checkHost({ ...base, workspaces: [{ id: 'a', path: pa }, { id: 'b', path: pb }] }).refuse).toEqual([`Workspaces "a" and "b" overlap, so a grant or a change in one reaches the other. Give each its own folder.`])
  })
  it('accepts separate sibling folders, even with a shared name prefix', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'a', path: '/srv/vo/workspaces/a' }, { id: 'b', path: '/srv/vo/workspaces/ab' }] })).toEqual({ refuse: [], warn: [] })
  })
  it('refuses a workspace that is the workspace root itself', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'dot', path: '/srv/vo/workspaces' }] }).refuse).toEqual([`Workspace "dot" is the whole workspace root. Give each workspace its own folder under WORKSPACE_ROOT.`])
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
    expect(r.refuse).toHaveLength(3) // root user, contains the project, contains the home folder
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
    expect(facts).toMatchObject({ claudeEnabled: true, allowRoot: false, dataDirMode: 0o700, homeCredentials: ['.ssh', '.netrc'] })
    expect(facts.workspaces).toEqual([{ id: 'sandbox', path: expect.stringContaining('sandbox') }])
    expect(facts.uid === null || typeof facts.uid === 'number').toBe(true)
  })
  it('checks the host when ENABLE_CLAUDE_RUNTIME=yes next to RUNTIME=mock, and not otherwise', () => {
    const s = setup({})
    const facts = (env: Record<string, string>) => {
      const parsed = parseConfig({ RUNTIME: 'mock', DATA_DIR: s.data, ...env }, dir)
      if (!parsed.ok) throw new Error(parsed.errors.join('; '))
      return readHostFacts(parsed.config, { HOME: s.home }, join(dir, 'app'))
    }
    expect(facts({}).claudeEnabled).toBe(false)
    expect(facts({ ENABLE_CLAUDE_RUNTIME: 'yes' }).claudeEnabled).toBe(true)
    expect(facts({ RUNTIME: 'claude' }).claudeEnabled).toBe(true)
  })
  it('reads the home folder as a real path and the workspace root', () => {
    const s = setup({})
    const facts = readHostFacts(s.config, { HOME: s.home }, join(dir, 'app'))
    expect(facts.home).toBe(realpathSync(s.home))
    expect(facts.workspaceRoot).toBe(realpathSync(s.root))
  })
  it('stops a setup whose workspace is the workspace root', () => {
    const s = setup({ WORKSPACES: 'dot:.' })
    const log = recordingLogger()
    expect(enforceHostSafety(s.config, log, { HOME: s.home }, join(dir, 'app'))).toBe(false)
    expect(log.lines.join('\n')).toContain('whole workspace root')
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


describe('checkHost compares folded names', () => {
  it('refuses a workspace that contains the project folder under a different spelling', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'big', path: '/SRV/Vo' }] }).refuse[0]).toContain('contains the application')
  })
  it('refuses a workspace that equals the home folder under a different case or Unicode fold', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'h', path: '/HOME/VO' }] }).refuse[0]).toContain('home folder')
    expect(checkHost({ ...base, home: '/home/ſo', workspaces: [{ id: 'h', path: '/home/SO' }] }).refuse[0]).toContain('home folder')
  })
  it('refuses overlapping workspaces and the workspace root whatever the case', () => {
    const r = checkHost({ ...base, workspaces: [{ id: 'a', path: '/srv/vo/workspaces/Team' }, { id: 'b', path: '/srv/vo/workspaces/team/x' }] })
    expect(r.refuse).toEqual([expect.stringContaining('overlap')])
    expect(checkHost({ ...base, workspaces: [{ id: 'dot', path: '/SRV/VO/WORKSPACES' }] }).refuse).toEqual([expect.stringContaining('whole workspace root')])
  })
  it('still accepts siblings that differ only by a longer name', () => {
    expect(checkHost({ ...base, workspaces: [{ id: 'a', path: '/SRV/vo/workspaces/a' }, { id: 'b', path: '/srv/vo/workspaces/AB' }] })).toEqual({ refuse: [], warn: [] })
  })
})

describe('countUnboundWriteRules', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const rule = (o: Partial<PermissionRule>): PermissionRule => ({ id: 'r', scope: 'agent', effect: 'allow', tool: 'Write', agentId: 'a', taskId: null, pathPattern: null, workspaceId: null, runtime: null, digest: null, createdAt: at, createdBy: 'user', expiresAt: null, revokedAt: null, usedAt: null, endedAt: null, reason: null, ...o })
  it('counts active agent and task allow rules for Write or Edit that have no workspace or no runtime', () => {
    expect(countUnboundWriteRules([rule({}), rule({ tool: 'Edit' }), rule({ scope: 'task', taskId: 't' })], at)).toBe(3)
    expect(countUnboundWriteRules([rule({ workspaceId: 'sandbox' }), rule({ runtime: 'claude' })], at)).toBe(2)
  })
  it('ignores bound, revoked, expired, used, ended, ask, deny, read and global rules', () => {
    expect(countUnboundWriteRules([
      rule({ workspaceId: 'sandbox', runtime: 'claude' }), rule({ runtime: 'mock', workspaceId: 'sandbox' }), rule({ revokedAt: at }), rule({ expiresAt: '2025-01-01T00:00:00.000Z' }), rule({ endedAt: at }),
      rule({ effect: 'ask' }), rule({ effect: 'deny' }), rule({ tool: 'Read' }), rule({ scope: 'global', agentId: null }), rule({ scope: 'once', digest: 'a'.repeat(64), taskId: 't' }),
    ], at)).toBe(0)
  })
  it('the warning names the count and carries no path', () => {
    expect(UNBOUND_WRITE_RULES_WARNING(2)).toBe('2 active agent or task permission rules allow file writes without being limited to one workspace and one runtime (they were made before those limits existed). Review and revoke them in the permissions panel.')
    expect(UNBOUND_WRITE_RULES_WARNING(1)).toContain('1 active agent or task permission rule allows')
  })
})
