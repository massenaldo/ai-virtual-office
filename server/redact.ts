import type { Logger } from './log'

/**
 * Secret redaction for anything that leaves the process as text: logs, audit records, error messages.
 * Patterns are best effort and deliberately greedy; false positives such as `tokens: 12` becoming `tokens: [REDACTED]`
 * are accepted, because a missed secret is worse than a hidden number.
 */

export const REDACTED = '[REDACTED]'
export const DEFAULT_SCRUB_CHARS = 512

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b([A-Za-z0-9_.-]{0,64}(?:key|secret|token|password|passwd)[A-Za-z0-9_.-]{0,64})("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, `$1$2${REDACTED}`],
]

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text)
}

/** Redacts, then cuts to maxChars (the last character becomes an ellipsis). */
export function scrub(text: string, maxChars: number = DEFAULT_SCRUB_CHARS): string {
  // Cut first: redaction cost grows with the input, and the part past maxChars is dropped anyway.
  const clean = redactSecrets(text.length > maxChars + 256 ? text.slice(0, maxChars + 256) : text)
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`
}

const describeError = (err: unknown): string => (err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err))

export function redactingLogger(inner: Logger): Logger {
  return {
    info: (msg) => inner.info(redactSecrets(msg)),
    warn: (msg) => inner.warn(redactSecrets(msg)),
    error: (msg, err) => (err === undefined ? inner.error(redactSecrets(msg)) : inner.error(redactSecrets(msg), redactSecrets(describeError(err)))),
  }
}

/** A message when the secret's value appears anywhere in the serialised config; null when it is unset, too short to be a key, or absent. */
export function findSecretInConfig(config: unknown, secret: string | undefined): string | null {
  if (secret === undefined || secret.length < 8) return null
  return JSON.stringify(config).includes(secret) ? 'a secret value is present in the config' : null
}
