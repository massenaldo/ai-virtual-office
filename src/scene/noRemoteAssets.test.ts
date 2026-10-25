/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'

// Every source file's text, read through Vite so the test needs no Node type definitions.
const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
const LOCAL = /https?:\/\/(localhost|127\.0\.0\.1)/g

describe('self-hosted assets', () => {
  it('reads the source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
  })

  it('loads nothing from remote hosts at runtime', () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) =>
      text.split('\n').flatMap((line, i) => {
        const remote = /https?:\/\//.test(line.replace(LOCAL, ''))
        return remote || /\bpreset=/.test(line) ? [`${file}:${i + 1}`] : []
      }))
    expect(offenders).toEqual([])
  })
})
