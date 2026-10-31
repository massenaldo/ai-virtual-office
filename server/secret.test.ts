import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Secret } from './secret'
import { parseConfig } from './config'
import { tempDataDir } from './test/helpers'

const TOKEN = 'secret-token-0123456789-abcdefghijklmnopqrstuvwxyz'

describe('Secret', () => {
  it('prints as [REDACTED] in every text form and keeps the value for reveal()', () => {
    const s = new Secret(TOKEN)
    expect(s.reveal()).toBe(TOKEN)
    for (const text of [String(s), `${s}`, JSON.stringify(s), JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 5 }), JSON.stringify(Object.entries(s))]) expect(text).not.toContain(TOKEN)
    expect(String(s)).toBe('[REDACTED]')
  })

  it('is what the parsed config holds for API_TOKEN', () => {
    const r = parseConfig({ DATA_DIR: tempDataDir(), API_TOKEN: TOKEN })
    if (!r.ok) throw new Error(r.errors.join('; '))
    expect(r.config.apiToken?.reveal()).toBe(TOKEN)
    expect(JSON.stringify(r.config)).not.toContain(TOKEN)
    expect(String(r.config.apiToken)).toBe('[REDACTED]')
    expect(inspect(r.config, { depth: 5 })).not.toContain(TOKEN)
  })
})
