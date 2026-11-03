// Settings for the public gateway only. The backend's own settings stay in server/config.ts.

export type PublicConfig = { ok: true; host: string; port: number; password: string; allowClaude: boolean } | { ok: false; errors: string[] }

export function readPublicConfig(env: Record<string, string | undefined>): PublicConfig {
  const errors: string[] = []
  const trimmed = (name: string): string => env[name]?.trim() ?? ''

  // Not trimmed: spaces may be part of a chosen password.
  const password = env.VO_PASSWORD ?? ''
  if (password === '') errors.push('VO_PASSWORD is required. Set it to a password of at least 12 characters.')
  else if (password.length < 12) errors.push('VO_PASSWORD must be at least 12 characters.')

  const rawPort = trimmed('PUBLIC_PORT')
  let port = 3000
  if (rawPort !== '') {
    port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN
    if (!(port >= 1 && port <= 65535)) errors.push(`PUBLIC_PORT must be an integer from 1 to 65535 (got "${rawPort}").`)
  }

  const host = trimmed('PUBLIC_HOST') || '0.0.0.0'
  if (/\s/.test(host)) errors.push('PUBLIC_HOST must be a host name or address with no spaces.')

  const allowClaude = trimmed('VO_ALLOW_PUBLIC_CLAUDE') === 'yes'
  if (trimmed('RUNTIME') === 'claude' && !allowClaude) {
    errors.push('RUNTIME=claude is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-3-report.md are met.')
  }

  if (trimmed('ENABLE_CLAUDE_RUNTIME') === 'yes' && !allowClaude) {
    errors.push('ENABLE_CLAUDE_RUNTIME=yes is not allowed on a public address. Set VO_ALLOW_PUBLIC_CLAUDE=yes only after the security prerequisites in docs/milestone-3b5-prerequisites.md are met.')
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, host, port, password, allowClaude }
}
