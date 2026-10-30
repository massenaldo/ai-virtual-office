/// <reference types="vite/client" />
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
