import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseConfig } from './config'
import { tempDataDir } from './test/helpers'
import { makeWorkspaceRoot } from './test/workspaces'
import { checkPathInWorkspace, resolveWorkspace } from './workspaces'

let ws: ReturnType<typeof makeWorkspaceRoot>
let outside: string
beforeEach(() => {
  ws = makeWorkspaceRoot(['sandbox'])
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'vo-outside-')))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
})
afterEach(() => { ws.cleanup(); rmSync(outside, { recursive: true, force: true }) })

const config = (env: Record<string, string> = ws.env) => {
  const r = parseConfig({ DATA_DIR: tempDataDir(), ...env })
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.config
}

describe('resolveWorkspace', () => {
  it('resolves a listed workspace to its real path', () => {
    expect(resolveWorkspace(config(), 'sandbox')).toEqual({ ok: true, workspace: { id: 'sandbox', path: ws.path('sandbox') } })
  })

  it('is not configured without a root', () => {
    expect(resolveWorkspace({ workspaceRoot: null, workspaces: [] }, 'sandbox')).toEqual({ ok: false, reason: 'not_configured' })
  })

  it('rejects malformed ids', () => {
    const c = config()
    for (const id of ['', '../etc', '/etc', 'a\0b', 'a\\b', 'Sandbox', 'a'.repeat(33), 'sand box', '-a', '.', 5, undefined, null]) {
      expect(resolveWorkspace(c, id)).toEqual({ ok: false, reason: 'invalid_id' })
    }
  })

  it('rejects an unlisted id', () => {
    expect(resolveWorkspace(config(), 'docs')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('rejects a workspace deleted after startup', () => {
    const c = config()
    rmSync(ws.path('sandbox'), { recursive: true })
    expect(resolveWorkspace(c, 'sandbox')).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects a workspace swapped for an outside symlink after startup', () => {
    const c = config()
    rmSync(ws.path('sandbox'), { recursive: true })
    symlinkSync(outside, ws.path('sandbox'))
    expect(resolveWorkspace(c, 'sandbox')).toEqual({ ok: false, reason: 'escapes_root' })
  })

  it('rejects a root that was replaced by a symlink after config', () => {
    const c = config()
    renameSync(ws.root, `${ws.root}-moved`)
    symlinkSync(outside, ws.root)
    mkdirSync(join(outside, 'sandbox'))
    try {
      expect(resolveWorkspace(c, 'sandbox')).toEqual({ ok: false, reason: 'escapes_root' })
    } finally {
      rmSync(ws.root, { force: true })
      renameSync(`${ws.root}-moved`, ws.root)
    }
  })

  it('follows a symlink that stays inside the root', () => {
    mkdirSync(join(ws.root, 'real'))
    symlinkSync(join(ws.root, 'real'), join(ws.root, 'alias'))
    const c = config({ WORKSPACE_ROOT: ws.root, WORKSPACES: 'alias:alias' })
    const r = resolveWorkspace(c, 'alias')
    expect(r).toEqual({ ok: true, workspace: { id: 'alias', path: realpathSync(join(ws.root, 'real')) } })
  })
})

describe('checkPathInWorkspace', () => {
  let W: string
  beforeEach(() => {
    W = ws.path('sandbox')
    writeFileSync(join(W, 'notes.md'), 'hi')
    mkdirSync(join(W, 'sub'))
    symlinkSync(outside, join(W, 'link'))
    symlinkSync(join(outside, 'secret.txt'), join(W, 'filelink'))
    symlinkSync(join(ws.root, 'nope'), join(W, 'dangling'))
  })

  it('refuses a file with more than one name (a hard link), and only an existing regular file', () => {
    linkSync(join(outside, 'secret.txt'), join(W, 'inside.txt'))
    expect(checkPathInWorkspace(W, 'inside.txt')).toEqual({ ok: false, reason: 'unsafe_link' })
    expect(checkPathInWorkspace(W, join(W, 'inside.txt'))).toEqual({ ok: false, reason: 'unsafe_link' })
    expect(checkPathInWorkspace(W, 'notes.md')).toEqual({ ok: true, relative: 'notes.md' })
    expect(checkPathInWorkspace(W, 'not-yet.txt')).toEqual({ ok: true, relative: 'not-yet.txt' })
    expect(checkPathInWorkspace(W, 'sub')).toEqual({ ok: true, relative: 'sub' })
    rmSync(join(W, 'inside.txt'))
    expect(checkPathInWorkspace(W, 'inside.txt')).toEqual({ ok: true, relative: 'inside.txt' })
  })

  it('rejects a path that goes through a regular file', () => {
    expect(checkPathInWorkspace(W, 'notes.md/x')).toEqual({ ok: false, reason: 'invalid_path' })
    expect(checkPathInWorkspace(W, 'notes.md/a/b.txt')).toEqual({ ok: false, reason: 'invalid_path' })
  })

  it('judges every call on the filesystem as it is now', () => {
    expect(checkPathInWorkspace(W, 'sub/out.txt')).toEqual({ ok: true, relative: 'sub/out.txt' })
    rmSync(join(W, 'sub'), { recursive: true })
    symlinkSync(outside, join(W, 'sub'))
    expect(checkPathInWorkspace(W, 'sub/out.txt')).toEqual({ ok: false, reason: 'outside_workspace' })
    rmSync(join(W, 'sub'))
    mkdirSync(join(W, 'sub'))
    expect(checkPathInWorkspace(W, 'sub/out.txt')).toEqual({ ok: true, relative: 'sub/out.txt' })
    renameSync(join(W, 'sub'), join(W, 'moved'))
    expect(checkPathInWorkspace(W, 'moved/out.txt')).toEqual({ ok: true, relative: 'moved/out.txt' })
  })

  it('accepts paths inside', () => {
    expect(checkPathInWorkspace(W, 'notes.md')).toEqual({ ok: true, relative: 'notes.md' })
    expect(checkPathInWorkspace(W, join(W, 'notes.md'))).toEqual({ ok: true, relative: 'notes.md' })
    expect(checkPathInWorkspace(W, '.')).toEqual({ ok: true, relative: '.' })
    expect(checkPathInWorkspace(W, 'sub/new/deep.txt')).toEqual({ ok: true, relative: 'sub/new/deep.txt' })
  })

  it('rejects paths outside', () => {
    for (const p of ['../x', '/etc/passwd', 'link', 'link/secret.txt', 'link/new.txt', 'filelink']) {
      expect(checkPathInWorkspace(W, p)).toEqual({ ok: false, reason: 'outside_workspace' })
    }
  })

  it('refuses any path with a .. segment, even one that would stay inside', () => {
    for (const p of ['link/../notes.md', 'sub/../notes.md', `${W}/link/../x`, 'a/b/../../notes.md', '..']) {
      expect(checkPathInWorkspace(W, p)).toEqual({ ok: false, reason: 'outside_workspace' })
    }
    expect(checkPathInWorkspace(W, 'sub/..hidden/x')).toEqual({ ok: true, relative: 'sub/..hidden/x' })
  })

  it('refuses a write through a dangling symlink', () => {
    expect(checkPathInWorkspace(W, 'dangling')).toEqual({ ok: false, reason: 'unsafe_symlink' })
  })

  it('rejects invalid paths', () => {
    for (const p of ['', 'a\0b', 'a\\b', 'x'.repeat(4097), 5, null]) {
      expect(checkPathInWorkspace(W, p)).toEqual({ ok: false, reason: 'invalid_path' })
    }
  })

  it('denies a path that names the workspace through an unresolved alias', () => {
    // On macOS tmpdir is a symlink; a lexical alias of the workspace is outside by the lexical step.
    const alias = W.replace('/private', '')
    if (alias !== W) expect(checkPathInWorkspace(W, join(alias, 'notes.md'))).toEqual({ ok: false, reason: 'outside_workspace' })
  })
})
