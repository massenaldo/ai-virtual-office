import { describe, expect, it } from 'vitest'
import { findSecretLeaks } from './secretScan'

const KEY = 'sk-ant-canary-0123456789'

describe('findSecretLeaks', () => {
  it('passes clean bundles', () => {
    expect(findSecretLeaks([{ path: 'dist/assets/index.js', text: 'x' }, { path: 'dist-server/index.js', text: 'process.env.ANTHROPIC_API_KEY' }], KEY)).toEqual([])
  })

  it('finds the key value anywhere', () => {
    expect(findSecretLeaks([{ path: 'dist/a.js', text: `const k="${KEY}"` }, { path: 'dist-server/index.js', text: `log("${KEY}")` }], KEY)).toEqual([
      'dist/a.js: contains the ANTHROPIC_API_KEY value',
      'dist/a.js: contains an sk-ant- key',
      'dist-server/index.js: contains the ANTHROPIC_API_KEY value',
      'dist-server/index.js: contains an sk-ant- key',
    ])
  })

  it('finds sk-ant- keys even when the configured key is unknown', () => {
    expect(findSecretLeaks([{ path: 'dist/a.js', text: 'x sk-ant-api03-abcdefghijkl y' }], undefined)).toEqual(['dist/a.js: contains an sk-ant- key'])
  })

  it('flags the variable name outside the server bundle', () => {
    expect(findSecretLeaks([{ path: 'dist/assets/index.js', text: 'import.meta.env.ANTHROPIC_API_KEY' }], undefined)).toEqual(['dist/assets/index.js: mentions ANTHROPIC_API_KEY (only dist-server/index.js and its source map may)'])
    expect(findSecretLeaks([{ path: 'dist-server/index.js.map', text: 'ANTHROPIC_API_KEY' }], undefined)).toEqual([])
  })

  it('ignores a key shorter than 8 characters', () => {
    expect(findSecretLeaks([{ path: 'dist/a.js', text: 'short abc123' }], 'abc123')).toEqual([])
  })

  it('does not mistake the redaction pattern source for a key', () => {
    expect(findSecretLeaks([{ path: 'dist-server/index.js', text: String.raw`/sk-ant-[A-Za-z0-9_-]{8,}/g` }], undefined)).toEqual([])
  })
})
