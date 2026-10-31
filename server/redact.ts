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
  const decoded = Buffer.from(encoded, 'base64').toString('latin1')
  return /^[\x20-\x7e]+$/.test(decoded) && decoded.indexOf(':') > 0 ? `${scheme} ${REDACTED}` : match
}

/**
 * scheme://user:password@host. The password may itself contain `@` or `/`, so the userinfo is cut at the last `@` of the
 * authority. Not credentials: `ssh://git@host` (no password), `/@scope` and `/@user` in a path, and `host:8080/...`
 * (what follows the colon is a port). Works on one bounded token, so it stays linear.
 */
const urlCredential = (match: string, scheme: string, rest: string): string => {
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  let at = authority.lastIndexOf('@')
  if (at === -1) {
    // No `@` before the first `/`: either a plain host, or a password containing `/` (`u:pa/ss@host`).
    const colon = authority.indexOf(':')
    if (colon === -1 || /^\d*$/.test(authority.slice(colon + 1))) return match
    at = rest.lastIndexOf('@')
    if (at === -1) return match
  }
  return rest.slice(0, at).includes(':') ? `${scheme}${REDACTED}@${rest.slice(at + 1)}` : match
}

/** `mysql -uroot -pSECRET`: the attached form only. `-p 22`, `-p8080:80`, `-print` and `mkdir -p` are not passwords. */
const mysqlPassword = (_match: string, head: string, _value: string): string => `${head}${REDACTED}`

const PATTERNS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [/\b([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s]{1,512})/gi, urlCredential],
  [/\beyJ[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{10,4096}\.[A-Za-z0-9_-]{5,4096}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,200}/g, REDACTED],
  [/\bxapp-\d-[A-Za-z0-9-]{10,200}/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, REDACTED],
  [/(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb)\b[^\n|;&]{0,200}?\s-p)(?!\d+(?::\d+)?(?:\s|$))(\S{1,128})/g, mysqlPassword],
  [/(\bsshpass\b[^\n|;&]{0,100}?\s-p\s*)("[^"]{0,256}"|'[^']{0,256}'|[^\s"']{1,256})/g, `$1${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,255}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // curl -u user:password and --user user:password
  [/(\s(?:-u|--user)\s+)[^\s:]{1,128}:[^\s]{1,256}/g, `$1${REDACTED}`],
  [/\b(Basic)\s+([A-Za-z0-9+/]{8,512}={0,2})/gi, basicCredential],
  // A secret passed as a command-line argument, with `=` or a space; `--password-file path` keeps its path.
  [/(--(?:password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key))(=|\s+)("[^"]{0,256}"|'[^']{0,256}'|[^\s"']{1,256})/gi, `$1$2${REDACTED}`],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b([A-Za-z0-9_.-]{0,64}(?:key|secret|token|password|passwd)[A-Za-z0-9_.-]{0,64})("?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, `$1$2${REDACTED}`],
]

/**
 * Private key blocks, found by scanning for the BEGIN line rather than with a pattern, so the cost is linear. A block with
 * no END line (a log cut short, or `scrub` cutting it) is redacted to the end of the text. Certificates and public keys stay.
 */
function redactPrivateKeys(text: string): string {
  const BEGIN = '-----BEGIN '
  let from = text.indexOf(BEGIN)
  if (from === -1) return text
  let out = ''
  let cursor = 0
  while (from !== -1) {
    const labelEnd = text.indexOf('-----', from + BEGIN.length)
    const label = labelEnd === -1 ? '' : text.slice(from + BEGIN.length, labelEnd)
    if (labelEnd === -1 || !/PRIVATE KEY$/.test(label) || label.length > 40) {
      from = text.indexOf(BEGIN, from + BEGIN.length)
      continue
    }
    const end = text.indexOf(`-----END ${label}-----`, labelEnd)
    out += text.slice(cursor, from) + REDACTED
    cursor = end === -1 ? text.length : end + `-----END ${label}-----`.length
    from = end === -1 ? -1 : text.indexOf(BEGIN, cursor)
  }
  return out + text.slice(cursor)
}

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((t, [re, to]) => t.replace(re, to as string), redactPrivateKeys(text))
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
