import type { Logger } from './log'

/**
 * Secret redaction for anything that leaves the process as text: logs, audit records, error messages.
 * Patterns are best effort and deliberately greedy; false positives such as `tokens: 12` becoming `tokens: [REDACTED]`
 * are accepted, because a missed secret is worse than a hidden number.
 */

export const REDACTED = '[REDACTED]'
export const DEFAULT_SCRUB_CHARS = 512

/** `Basic <base64>` is a credential only when the base64 decodes to printable `user:password`, so "Basic configuration" survives. */
const basicCredential = (match: string, scheme: string, encoded: string): string => {
  if (encoded.length % 4 !== 0) return match
  const decoded = Buffer.from(encoded, 'base64').toString('latin1')
  return /^[\x20-\x7e]+$/.test(decoded) && decoded.indexOf(':') > 0 ? `${scheme} ${REDACTED}` : match
}

const PATTERNS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  // scheme://user:password@host: the userinfo is replaced; `ssh://git@host` (no password) and `/@user` paths are not credentials.
  [/\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@:]{1,128}:[^\s/@]{1,256}@/gi, `$1${REDACTED}@`],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,255}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\b(Basic)\s+([A-Za-z0-9+/]{8,512}={0,2})/gi, basicCredential],
  // A secret passed as a command-line argument, with `=` or a space; `--password-file path` keeps its path.
  [/(--(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key))(=|\s+)("[^"]{0,256}"|'[^']{0,256}'|[^\s"']{1,256})/gi, `$1$2${REDACTED}`],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b([A-Za-z0-9_.-]{0,64}(?:key|secret|token|password|passwd)[A-Za-z0-9_.-]{0,64})("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, `$1$2${REDACTED}`],
]

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, to]) => t.replace(re, to as string), text)
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
