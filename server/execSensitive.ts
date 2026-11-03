import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { foldName } from './sensitivePaths'

// Files that other tools run on their own (npm scripts, git hooks, editor and CI settings, build files, shell scripts). A change
// to one is a code change in disguise, so it is only ever approved once, whatever scope or rule would otherwise allow it.

const NAMES: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml',
  'makefile', 'gnumakefile', 'justfile', 'taskfile.yml', 'taskfile.yaml', 'dockerfile', 'conftest.py', 'setup.py', 'setup.cfg', 'pyproject.toml',
  'tox.ini', 'noxfile.py', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'cargo.toml', 'build.rs', 'go.mod',
  '.gitlab-ci.yml', '.mcp.json', '.pre-commit-config.yaml', '.envrc', '.gitattributes', 'claude.md', 'agents.md',
  'lefthook.yml', 'lefthook.yaml', 'jenkinsfile', 'gemfile', 'gemfile.lock', 'rakefile', 'bunfig.toml', 'compose.yml', 'compose.yaml', 'containerfile',
  'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'sitecustomize.py', 'usercustomize.py', 'claude.local.md',
])
const EXTENSIONS: readonly string[] = ['.config.js', '.config.ts', '.config.mjs', '.config.cjs', '.config.mts', '.config.cts', '.mk', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd']
const DIRECTORIES: ReadonlySet<string> = new Set(['.husky', '.githooks', '.claude', '.vscode', '.idea', '.github', '.gitlab', '.circleci', '.devcontainer', 'node_modules', 'vendor', 'site-packages', 'venv'])
const MORE_EXTENSIONS: readonly string[] = ['.pth', '.code-workspace']
const PREFIXES: readonly string[] = ['dockerfile.', 'containerfile.']
// A hidden file or folder is tool settings or an environment that runs on its own; only these two are plain text.
const HIDDEN_OK: ReadonlySet<string> = new Set(['.gitignore', '.editorconfig'])
// eslintrc.cjs, babelrc.js, mocharc.yml: a runtime-config file named *rc, with or without an extension.
const RC_FILE = /rc(\.(js|cjs|mjs|ts|json|yml|yaml|toml))?$/

function sensitiveName(segment: string): boolean {
  const s = foldName(segment)
  if (s.startsWith('.') && !HIDDEN_OK.has(s)) return true
  return NAMES.has(s) || DIRECTORIES.has(s) || EXTENSIONS.some((e) => s.endsWith(e)) || MORE_EXTENSIONS.some((e) => s.endsWith(e)) || PREFIXES.some((p) => s.startsWith(p)) || (s.startsWith('docker-compose') && (s.endsWith('.yml') || s.endsWith('.yaml')))
}

/** True when the file is a regular file (not a link) with an execute bit. A missing file is judged by its name alone. */
function isExecutableFile(absolute: string): boolean {
  try {
    const st = lstatSync(absolute)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false
    throw e
  }
}

/** True when a write to this workspace-relative path must be approved once. Never throws: any doubt is true. */
export function isExecSensitive(relative: string, workspacePath: string): boolean {
  try {
    const segments = relative.split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
    if (segments.includes('..') || segments.length === 0) return true
    if (segments.some(sensitiveName)) return true
    if (RC_FILE.test(foldName(segments[segments.length - 1]!))) return true
    return isExecutableFile(join(workspacePath, ...segments))
  } catch {
    return true
  }
}
