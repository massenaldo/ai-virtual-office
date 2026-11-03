/**
 * The environment of the Claude Code child process. The SDK replaces the child's environment with this object, so only what
 * is listed here reaches it: no server token, no cloud credentials, no SSH agent, no inspector flags. The key is passed in
 * by the provider (read once from the server's config) and never taken from `base`.
 */
export function buildChildEnv(opts: { apiKey: string; home: string; configDir: string; base: Record<string, string | undefined>; /** A local scripted API for tests; absent means Anthropic's own endpoint. */ apiBaseUrl?: string | null }): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: opts.apiKey,
    HOME: opts.home,
    // The CLI's own state (config, caches) lives in a folder the server owns, inside the protected data folder.
    CLAUDE_CONFIG_DIR: opts.configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // A stalled or failing API call ends the task instead of waiting for ten minutes and retrying ten times.
    API_TIMEOUT_MS: '120000',
    CLAUDE_CODE_MAX_RETRIES: '2',
  }
  if (opts.base.PATH !== undefined) env.PATH = opts.base.PATH
  if (opts.apiBaseUrl) env.ANTHROPIC_BASE_URL = opts.apiBaseUrl
  return env
}
