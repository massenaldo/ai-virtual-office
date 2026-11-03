import { describe, expect, it } from 'vitest'
import { buildChildEnv } from './claudeEnv'

const base = { PATH: '/usr/bin:/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'sk-ant-api03-from-server-env', AWS_SECRET_ACCESS_KEY: 'aws', GITHUB_TOKEN: 'gh', SSH_AUTH_SOCK: '/tmp/agent', API_TOKEN: 'x'.repeat(40), NODE_OPTIONS: '--inspect' }

describe('buildChildEnv', () => {
  const env = buildChildEnv({ apiKey: 'sk-ant-api03-the-key', home: '/data/claude-scratch', configDir: '/data/claude-config', base })

  it('holds exactly the allowed variables and nothing inherited from the server', () => {
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'API_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'])
  })
  it('uses the given key, not one from the server environment, and the given home and config folders', () => {
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-api03-the-key', HOME: '/data/claude-scratch', CLAUDE_CONFIG_DIR: '/data/claude-config', PATH: '/usr/bin:/bin' })
  })
  it('turns auto memory off and bounds API waits and retries', () => {
    expect(env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', API_TIMEOUT_MS: '120000', CLAUDE_CODE_MAX_RETRIES: '2' })
  })
  it('points the SDK at a scripted API only when one is given', () => {
    expect(buildChildEnv({ apiKey: 'k', home: '/h', configDir: '/c', base: {}, apiBaseUrl: 'http://127.0.0.1:9' })).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
  })
  it('leaves out PATH when the server has none', () => {
    expect(buildChildEnv({ apiKey: 'k', home: '/h', configDir: '/c', base: {} })).not.toHaveProperty('PATH')
  })
})
