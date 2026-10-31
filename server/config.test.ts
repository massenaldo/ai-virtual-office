import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Secret } from './secret'
import { CONFIG_VARIABLES, formatConfigErrors, mergeEnv, parseConfig } from './config'
import { makeWorkspaceRoot } from './test/workspaces'

const DEFAULTS = { host: '127.0.0.1', port: 8787, dataDir: '/repo/data', runtime: 'mock', taskTimeoutMs: 600000, cancelGraceMs: 5000, approvalTimeoutMs: 300000, maxMessageBytes: 32768, maxTaskOutputBytes: 262144, eventBufferSize: 500, auditLogMaxBytes: 5242880, workspaceRoot: null, workspaces: [], allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentialsConfigured: false, apiToken: null }
const NAMES = CONFIG_VARIABLES

describe('parseConfig', () => {
  it('uses the defaults for an empty environment', () => {
    expect(parseConfig({}, '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('treats empty strings as unset', () => {
    expect(parseConfig(Object.fromEntries(NAMES.map((n) => [n, ''])), '/repo')).toEqual({ ok: true, config: DEFAULTS })
  })

  it('reads every variable', () => {
    const r = parseConfig({ HOST: 'localhost', PORT: '9000', DATA_DIR: 'tmp/x', RUNTIME: 'claude', TASK_TIMEOUT_MS: '1000', CANCEL_GRACE_MS: '200', APPROVAL_TIMEOUT_MS: '3000', MAX_MESSAGE_BYTES: '100', MAX_TASK_OUTPUT_BYTES: '1000', EVENT_BUFFER_SIZE: '20', AUDIT_LOG_MAX_BYTES: '65536', ANTHROPIC_API_KEY: 'k', API_TOKEN: 't'.repeat(40) }, '/repo')
    expect(r).toEqual({ ok: true, config: { host: 'localhost', port: 9000, dataDir: '/repo/tmp/x', runtime: 'claude', taskTimeoutMs: 1000, cancelGraceMs: 200, approvalTimeoutMs: 3000, maxMessageBytes: 100, maxTaskOutputBytes: 1000, eventBufferSize: 20, auditLogMaxBytes: 65536, workspaceRoot: null, workspaces: [], allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'], allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'], credentialsConfigured: true, apiToken: expect.any(Secret) } })
    expect(r.ok && r.config.apiToken?.reveal()).toBe('t'.repeat(40))
  })

  it('collects every error with readable copy', () => {
    expect(parseConfig({ PORT: 'abc', RUNTIME: 'gpt', TASK_TIMEOUT_MS: '0' }, '/repo')).toEqual({
      ok: false,
      errors: ['PORT must be an integer from 0 to 65535 (got "abc").', 'RUNTIME must be "mock" or "claude" (got "gpt").', 'TASK_TIMEOUT_MS must be a positive integer (got "0").'],
    })
  })

  it('refuses a non-loopback HOST', () => {
    expect(parseConfig({ HOST: '0.0.0.0' }, '/repo')).toEqual({ ok: false, errors: ['HOST must be a loopback address (127.0.0.1, ::1 or localhost) (got "0.0.0.0"). Remote access needs TLS and authentication, which this server does not have yet.'] })
    expect(parseConfig({ HOST: 'localhost' }, '/repo').ok).toBe(true)
    expect(parseConfig({ HOST: '::1' }, '/repo').ok).toBe(true)
  })

  it('rejects a message cap larger than the task cap', () => {
    expect(parseConfig({ MAX_MESSAGE_BYTES: '2000', MAX_TASK_OUTPUT_BYTES: '1000' }, '/repo')).toEqual({ ok: false, errors: ['MAX_MESSAGE_BYTES must not exceed MAX_TASK_OUTPUT_BYTES.'] })
  })

  it('rejects out-of-range and fractional numbers', () => {
    expect(parseConfig({ PORT: '70000' }, '/repo').ok).toBe(false)
    expect(parseConfig({ PORT: '1.5' }, '/repo').ok).toBe(false)
    expect(parseConfig({ CANCEL_GRACE_MS: '-1' }, '/repo').ok).toBe(false)
    expect(parseConfig({ PORT: '0' }, '/repo').ok).toBe(true)
  })

  it('rejects a timer longer than Node can schedule', () => {
    const max = 2147483647
    for (const name of ['TASK_TIMEOUT_MS', 'CANCEL_GRACE_MS', 'APPROVAL_TIMEOUT_MS']) {
      expect(parseConfig({ [name]: String(max) }, '/repo').ok).toBe(true)
      expect(parseConfig({ [name]: String(max + 1) }, '/repo')).toEqual({ ok: false, errors: [`${name} must be at most 2147483647 ms, about 24 days (got "${max + 1}").`] })
    }
    expect(parseConfig({ TASK_TIMEOUT_MS: '9'.repeat(400) }, '/repo').ok).toBe(false)
  })

  it('keeps only a flag for the API key', () => {
    const r = parseConfig({ ANTHROPIC_API_KEY: 'sk-test-123' }, '/repo')
    expect(r.ok && r.config.credentialsConfigured).toBe(true)
    expect(JSON.stringify(r)).not.toContain('sk-test-123')
    expect(parseConfig({ ANTHROPIC_API_KEY: '   ' }, '/repo')).toMatchObject({ config: { credentialsConfigured: false } })
  })
})

describe('mergeEnv', () => {
  it('lets the real environment win', () => {
    expect(mergeEnv('PORT=9000\nHOST=localhost', { PORT: '8000' })).toMatchObject({ PORT: '8000', HOST: 'localhost' })
    const env = { A: '1' }
    const copy = mergeEnv(null, env)
    expect(copy).toEqual(env)
    expect(copy).not.toBe(env)
  })
})

describe('formatConfigErrors', () => {
  it('lists every error', () => {
    expect(formatConfigErrors(['A', 'B'])).toBe('Server config is invalid:\n- A\n- B')
  })
})

describe('security-related config', () => {
  it('reads AUDIT_LOG_MAX_BYTES and enforces its range', () => {
    const copy = (v: string) => `AUDIT_LOG_MAX_BYTES must be from 65536 to 1073741824 (got "${v}").`
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '1000' }, '/repo')).toEqual({ ok: false, errors: [copy('1000')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: 'abc' }, '/repo')).toEqual({ ok: false, errors: [copy('abc')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '2000000000' }, '/repo')).toEqual({ ok: false, errors: [copy('2000000000')] })
    expect(parseConfig({ AUDIT_LOG_MAX_BYTES: '65536' }, '/repo')).toMatchObject({ ok: true, config: { auditLogMaxBytes: 65536 } })
  })

  it('refuses permission-bypass variables', () => {
    const r = parseConfig({ DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_PERMISSION_MODE: 'x', BYPASS_PERMISSIONS: '' }, '/repo')
    expect(r).toEqual({
      ok: false,
      errors: [
        'DANGEROUSLY_SKIP_PERMISSIONS is not supported: this server has no way to skip permission checks. Remove it.',
        'CLAUDE_PERMISSION_MODE is not supported: this server has no way to skip permission checks. Remove it.',
        'BYPASS_PERMISSIONS is not supported: this server has no way to skip permission checks. Remove it.',
      ],
    })
  })

  it('no config variable suggests a bypass', () => {
    expect(CONFIG_VARIABLES.filter((n) => /bypass|danger|skip|unsafe|yolo|permission/i.test(n))).toEqual([])
  })

  it('.env.example lists exactly the config variables', () => {
    const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    const names = new Set(text.split('\n').flatMap((l) => (/^([A-Z0-9_]+)=/.exec(l) ? [/^([A-Z0-9_]+)=/.exec(l)![1]] : [])))
    expect(names).toEqual(new Set([...CONFIG_VARIABLES, 'VITE_WORKFORCE_API_URL']))
  })
})

describe('workspace config', () => {
  let ws: ReturnType<typeof makeWorkspaceRoot>
  let outside: string
  beforeEach(() => {
    ws = makeWorkspaceRoot(['sandbox'])
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'vo-outside-')))
    writeFileSync(join(ws.root, 'notes.md'), 'x')
    symlinkSync(outside, join(ws.root, 'link'))
    mkdirSync(join(ws.root, 'team', 'docs'), { recursive: true })
  })
  afterEach(() => { ws.cleanup(); rmSync(outside, { recursive: true, force: true }) })
  const cfg = (env: Record<string, string>) => parseConfig({ DATA_DIR: '/nonexistent-data', ...env }, '/repo')

  it('reads WORKSPACE_ROOT and WORKSPACES', () => {
    expect(cfg({ WORKSPACE_ROOT: ws.root, WORKSPACES: ' sandbox:sandbox , docs:team/docs ' })).toMatchObject({
      ok: true,
      config: { workspaceRoot: ws.root, workspaces: [{ id: 'sandbox', relativePath: 'sandbox' }, { id: 'docs', relativePath: 'team/docs' }] },
    })
  })

  it('refuses a bad WORKSPACE_ROOT', () => {
    expect(cfg({ WORKSPACE_ROOT: 'rel/dir' })).toEqual({ ok: false, errors: ['WORKSPACE_ROOT must be an absolute path (got "rel/dir").'] })
    expect(cfg({ WORKSPACE_ROOT: '/definitely/not/here' })).toEqual({ ok: false, errors: ['WORKSPACE_ROOT must be an existing directory (got "/definitely/not/here").'] })
    const file = join(ws.root, 'notes.md')
    expect(cfg({ WORKSPACE_ROOT: file })).toEqual({ ok: false, errors: [`WORKSPACE_ROOT must be an existing directory (got "${file}").`] })
    expect(cfg({ WORKSPACE_ROOT: '/' })).toEqual({ ok: false, errors: ['WORKSPACE_ROOT must not be the filesystem root.'] })
  })

  it('refuses WORKSPACES without WORKSPACE_ROOT', () => {
    expect(cfg({ WORKSPACES: 'sandbox:sandbox' })).toEqual({ ok: false, errors: ['WORKSPACES needs WORKSPACE_ROOT.'] })
  })

  it.each([
    ['sandbox', 'WORKSPACES entry "sandbox" must look like id:relative/path.'],
    ['Sandbox:sandbox', 'Workspace id "Sandbox" must be 1–32 lowercase letters, digits or hyphens, starting with a letter or digit.'],
    ['a:/etc', 'Workspace "a" path must be relative to WORKSPACE_ROOT (got "/etc").'],
    ['a:../x', 'Workspace "a" path must not contain "..".'],
    ['a:sandbox/../../x', 'Workspace "a" path must not contain "..".'],
    ['a:sand\\box', 'Workspace "a" path contains a forbidden character.'],
    ['a:missing', 'Workspace "a" must be an existing directory under WORKSPACE_ROOT (got "missing").'],
    ['a:notes.md', 'Workspace "a" must be an existing directory under WORKSPACE_ROOT (got "notes.md").'],
    ['a:link', 'Workspace "a" resolves outside WORKSPACE_ROOT.'],
    ['sandbox:sandbox,sandbox:sandbox', 'Workspace id "sandbox" is listed twice.'],
  ])('refuses bad workspace entry %s', (entry, message) => {
    expect(cfg({ WORKSPACE_ROOT: ws.root, WORKSPACES: entry })).toEqual({ ok: false, errors: [message] })
  })

  it('refuses more than 32 workspaces', () => {
    const ids = Array.from({ length: 33 }, (_, i) => `w${i}`)
    for (const id of ids) mkdirSync(join(ws.root, id))
    expect(cfg({ WORKSPACE_ROOT: ws.root, WORKSPACES: ids.map((id) => `${id}:${id}`).join(',') })).toEqual({ ok: false, errors: ['WORKSPACES lists more than 32 workspaces.'] })
  })

  it('refuses DATA_DIR inside a workspace', () => {
    expect(cfg({ WORKSPACE_ROOT: ws.root, WORKSPACES: ws.env.WORKSPACES, DATA_DIR: join(ws.path('sandbox'), 'data') })).toEqual({ ok: false, errors: ['DATA_DIR must not be inside workspace "sandbox".'] })
  })
})

describe('ALLOWED_TOOLS', () => {
  it('reads ALLOWED_TOOLS', () => {
    expect(parseConfig({ ALLOWED_TOOLS: ' Bash, Read ,Bash' }, '/repo')).toMatchObject({ ok: true, config: { allowedTools: ['Bash', 'Read'] } })
    expect(parseConfig({ ALLOWED_TOOLS: 'none' }, '/repo')).toMatchObject({ ok: true, config: { allowedTools: [] } })
  })

  it('refuses wildcard and unknown tools', () => {
    expect(parseConfig({ ALLOWED_TOOLS: '*' }, '/repo')).toEqual({ ok: false, errors: ['ALLOWED_TOOLS must list tool names; "*" is not allowed.'] })
    expect(parseConfig({ ALLOWED_TOOLS: 'all' }, '/repo')).toEqual({ ok: false, errors: ['ALLOWED_TOOLS must list tool names; "all" is not allowed.'] })
    expect(parseConfig({ ALLOWED_TOOLS: 'Read,Foo' }, '/repo')).toEqual({ ok: false, errors: ['ALLOWED_TOOLS has an unknown tool "Foo". Known tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch.'] })
  })
})

describe('ALLOWED_ORIGINS', () => {
  it('reads ALLOWED_ORIGINS', () => {
    expect(parseConfig({ ALLOWED_ORIGINS: ' http://a.local:3000 , https://b.example ' }, '/repo')).toMatchObject({ ok: true, config: { allowedOrigins: ['http://a.local:3000', 'https://b.example'] } })
    expect(parseConfig({ ALLOWED_ORIGINS: 'none' }, '/repo')).toMatchObject({ ok: true, config: { allowedOrigins: [] } })
  })

  it.each([
    ['*', 'ALLOWED_ORIGINS must list exact origins; "*" is not allowed.'],
    ['null', 'ALLOWED_ORIGINS must list exact origins; "null" is not allowed.'],
    ['http://', 'ALLOWED_ORIGINS entry "http://" is not a valid origin (expected something like http://localhost:5173).'],
    ['localhost:5173', 'ALLOWED_ORIGINS entry "localhost:5173" must use http or https.'],
    ['ftp://x.example', 'ALLOWED_ORIGINS entry "ftp://x.example" must use http or https.'],
    ['http://localhost:5173/', 'ALLOWED_ORIGINS entry "http://localhost:5173/" must be an origin only, like http://localhost:5173.'],
  ])('refuses bad origin %s', (value, message) => {
    expect(parseConfig({ ALLOWED_ORIGINS: value }, '/repo')).toEqual({ ok: false, errors: [message] })
  })

  it('refuses more than 16 origins', () => {
    const many = Array.from({ length: 17 }, (_, i) => `http://h${i}.local:3000`).join(',')
    expect(parseConfig({ ALLOWED_ORIGINS: many }, '/repo')).toEqual({ ok: false, errors: ['ALLOWED_ORIGINS lists more than 16 origins.'] })
  })
})

