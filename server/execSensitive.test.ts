import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExecSensitive } from './execSensitive'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'vo-exec-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const NAMES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml', 'Makefile', 'GNUmakefile', 'rules.mk',
  'justfile', 'Taskfile.yml', 'Taskfile.yaml', 'Dockerfile', 'docker-compose.yml', 'docker-compose.dev.yaml', 'conftest.py', 'setup.py', 'setup.cfg', 'pyproject.toml',
  'tox.ini', 'noxfile.py', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'Cargo.toml', 'build.rs', 'go.mod', 'a.sh', 'a.bash', 'a.zsh', 'a.ps1', 'a.bat', 'a.cmd',
  '.gitlab-ci.yml', '.mcp.json', '.pre-commit-config.yaml', '.envrc', '.gitattributes', 'vite.config.ts', 'vitest.config.mts', 'eslint.config.js', 'jest.config.cjs', 'webpack.config.mjs', 'x.config.cts', 'CLAUDE.md', 'AGENTS.md',
]
const DIRS = ['.husky', '.githooks', '.claude', '.vscode', '.idea', '.github', '.gitlab', '.circleci', '.devcontainer']

describe('isExecSensitive', () => {
  it.each(NAMES)('%s is sensitive, at the top and nested', (name) => {
    expect(isExecSensitive(name, ws)).toBe(true)
    expect(isExecSensitive(`packages/app/${name}`, ws)).toBe(true)
  })
  it.each(DIRS)('anything under %s is sensitive', (dir) => {
    expect(isExecSensitive(`${dir}/anything.txt`, ws)).toBe(true)
    expect(isExecSensitive(`sub/${dir}/deep/x.txt`, ws)).toBe(true)
  })
  it('folds names the way a case-insensitive file system does', () => {
    expect(isExecSensitive('PACKAGE.JSON', ws)).toBe(true)
    expect(isExecSensitive('.HUSKY/pre-commit', ws)).toBe(true)
    expect(isExecSensitive('scripts/BUILD.SH', ws)).toBe(true)
  })
  it('a .sh deep in the tree is sensitive', () => expect(isExecSensitive('a/b/c/d/e/run.sh', ws)).toBe(true))
  it('ordinary files are not', () => {
    writeFileSync(join(ws, 'notes.txt'), 'x')
    chmodSync(join(ws, 'notes.txt'), 0o644)
    for (const p of ['notes.txt', 'docs/plan.md', 'src/index.ts', 'new/file.txt', 'package.jsonx', '.editorconfig', 'config.txt', 'shell.txt']) expect(isExecSensitive(p, ws)).toBe(false)
  })
  it('an existing file with an execute bit is sensitive whatever its name', () => {
    writeFileSync(join(ws, 'run'), '#!/bin/sh\n')
    chmodSync(join(ws, 'run'), 0o755)
    expect(isExecSensitive('run', ws)).toBe(true)
    mkdirSync(join(ws, 'bin'))
    writeFileSync(join(ws, 'bin', 'tool'), 'x')
    chmodSync(join(ws, 'bin', 'tool'), 0o700)
    expect(isExecSensitive('bin/tool', ws)).toBe(true)
  })
  it('a symlink is judged by its name, not its target', () => {
    writeFileSync(join(ws, 'target'), 'x')
    chmodSync(join(ws, 'target'), 0o755)
    symlinkSync(join(ws, 'target'), join(ws, 'link.txt'))
    expect(isExecSensitive('link.txt', ws)).toBe(false)
    symlinkSync(join(ws, 'target'), join(ws, 'link.sh'))
    expect(isExecSensitive('link.sh', ws)).toBe(true)
  })
  it('fails closed: an unreadable workspace path or a climbing path is sensitive', () => {
    expect(isExecSensitive('../x.txt', ws)).toBe(true)
    expect(isExecSensitive('x.txt', 'a\0b')).toBe(true)
  })
})

describe('isExecSensitive: hidden names and the wider class', () => {
  const HIDDEN = ['.eslintrc.cjs', '.cargo/config.toml', '.cursor/mcp.json', '.gemini/settings.json', '.yarn/releases/yarn-4.cjs', '.venv/lib/x.py', '.config/x', '.pre-commit-config.yaml', '.husky/pre-commit', '.anything', 'sub/.hidden/deep.txt', '.prettierrc.js', '.travis.yml', '.buildkite/pipeline.yml']
  it.each(HIDDEN)('%s is sensitive (hidden segment)', (p) => expect(isExecSensitive(p, ws)).toBe(true))
  const MORE = [
    'node_modules/lodash/index.js', 'vendor/x/a.rb', 'venv/bin/a', 'lib/site-packages/a.py', 'lefthook.yml', 'lefthook.yaml', 'Jenkinsfile', 'Gemfile', 'Gemfile.lock', 'Rakefile',
    'bunfig.toml', 'compose.yml', 'compose.yaml', 'Containerfile', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'sitecustomize.py', 'usercustomize.py', 'Dockerfile.prod', 'Containerfile.dev',
    'a.pth', 'my.code-workspace', 'CLAUDE.local.md', 'eslintrc.cjs', 'babelrc.js', 'mocharc.yml', 'lintstagedrc', 'sub/prettierrc.json', 'x/jestrc.toml', 'a/b/NODE_MODULES/x.txt',
  ]
  it.each(MORE)('%s is sensitive', (p) => expect(isExecSensitive(p, ws)).toBe(true))
  it.each(['notes.txt', 'src/a.ts', 'README.md', 'docs/guide.md', '.gitignore', '.editorconfig', 'sub/.gitignore', 'config.js', 'tarc.txt', 'src/rc.txt', 'lockfile.txt', 'vendors.md'])('%s stays allowed', (p) => expect(isExecSensitive(p, ws)).toBe(false))
})

