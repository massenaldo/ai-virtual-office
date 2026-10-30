/// <reference types="vite/client" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every non-test source file the backend and the shared model can reach, read as text.
const sources = import.meta.glob<string>(['./**/*.ts', '../src/**/*.{ts,tsx}', '../scripts/*.ts', '!./**/*.test.ts', '!../src/**/*.test.{ts,tsx}', '!../scripts/*.test.ts'], { query: '?raw', import: 'default', eager: true })

// The lookbehind allows re.exec( and other objects' .spawn(, which are not process execution.
const FORBIDDEN = [/child_process/, /(?<![.\w])exec(Sync|File|FileSync)?\(/, /(?<![.\w])spawn(Sync)?\(/, /(?<![.\w])fork\(/, /worker_threads/]

describe('no process execution', () => {
  it('reads the backend, the shared model and the dev script', () => {
    const files = Object.keys(sources)
    expect(files).toContain('./index.ts')
    expect(files).toContain('../src/workforce/operations.ts')
    expect(files).toContain('../scripts/devFull.ts')
  })

  it('has no child process, exec, spawn, fork or worker threads', () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) => FORBIDDEN.filter((re) => re.test(text)).map((re) => `${file} ${re}`))
    expect(offenders).toEqual([])
  })
})

const BYPASS = [/dangerously/i, /bypass_?permissions/i, /skip[-_]?permissions/i]
// A matching line is allowed only if it also matches the listed pattern: the one line that refuses such settings.
const BYPASS_ALLOWED: Record<string, RegExp> = { './config.ts': /REFUSED_ENV_PATTERN/ }
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

describe('no permission bypass', () => {
  it('has no permission-bypass options', () => {
    expect(Object.keys(sources)).toContain('./runtime/claudeAgent.ts')
    const all: Record<string, string> = { ...sources, '../package.json': read('package.json'), '../.env.example': read('.env.example') }
    const offenders = Object.entries(all).flatMap(([file, text]) =>
      text.split('\n').flatMap((line, i) => (BYPASS.some((re) => re.test(line)) && !BYPASS_ALLOWED[file]?.test(line) ? [`${file}:${i + 1}`] : [])))
    expect(offenders).toEqual([])
  })

  it('keeps .env out of git', () => {
    expect(read('.gitignore').split('\n').map((l) => l.trim())).toContain('.env')
    expect(read('.env.example')).not.toMatch(/^[A-Z0-9_]+=\S/m)
  })
})

