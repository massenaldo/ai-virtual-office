import { MIN_TOKEN_CHARS } from './auth'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { findSecretInConfig } from './redact'
import { DEFAULT_ALLOWED_TOOLS, TOOL_CATALOGUE } from './toolPolicy'
import { parseWorkspaces, type WorkspaceEntry } from './workspaces'

export type RuntimeKind = 'mock' | 'claude'

export type ServerConfig = { host: string; port: number; dataDir: string; runtime: RuntimeKind; taskTimeoutMs: number; cancelGraceMs: number; approvalTimeoutMs: number; maxMessageBytes: number; maxTaskOutputBytes: number; eventBufferSize: number; auditLogMaxBytes: number; workspaceRoot: string | null; workspaces: WorkspaceEntry[]; allowedTools: string[]; allowedOrigins: string[]; credentialsConfigured: boolean; /** Server-only secret; null means one is generated at start. Never log or serialise the config with it. */ apiToken: string | null }

export type Env = Record<string, string | undefined>

type Parsed = { ok: true; config: ServerConfig } | { ok: false; errors: string[] }

/** Every environment variable parseConfig reads, in .env.example order. */
export const CONFIG_VARIABLES: readonly string[] = ['HOST', 'PORT', 'ALLOWED_ORIGINS', 'DATA_DIR', 'WORKSPACE_ROOT', 'WORKSPACES', 'RUNTIME', 'TASK_TIMEOUT_MS', 'CANCEL_GRACE_MS', 'APPROVAL_TIMEOUT_MS', 'ALLOWED_TOOLS', 'MAX_MESSAGE_BYTES', 'MAX_TASK_OUTPUT_BYTES', 'EVENT_BUFFER_SIZE', 'AUDIT_LOG_MAX_BYTES', 'API_TOKEN', 'ANTHROPIC_API_KEY']

/** Environment names that suggest skipping permission checks. This server has no such switch, so their presence is an error rather than being ignored. */
export const REFUSED_ENV_PATTERN = /DANGEROUSLY|BYPASS_?PERMISSIONS|SKIP_?PERMISSIONS|PERMISSION_MODE/i

/** Names that would put a secret into the frontend bundle (VITE_WORKFORCE_API_URL is a plain address and fine). */
const FRONTEND_SECRET_PATTERN = /^VITE_.*(TOKEN|KEY|SECRET|PASSWORD)/i

const LOOPBACK = ['127.0.0.1', '::1', 'localhost']
const MAX_TIMER_MS = 2147483647

/** Empty strings count as unset, so a copied .env.example gives the defaults. */
const read = (env: Env, name: string): string | undefined => {
  const v = env[name]
  return v === undefined || v === '' ? undefined : v
}

/**
 * Typed config from the environment, with every problem collected and readable. The API key is reduced to a flag here
 * so the value can never end up in a log, a response or a serialised config.
 */
export function parseConfig(env: Env, cwd: string = process.cwd()): Parsed {
  const errors: string[] = []
  for (const name of Object.keys(env)) {
    if (REFUSED_ENV_PATTERN.test(name)) errors.push(`${name} is not supported: this server has no way to skip permission checks. Remove it.`)
    // A VITE_ variable is compiled into the browser bundle, so a secret must never use that prefix.
    else if (FRONTEND_SECRET_PATTERN.test(name)) errors.push(`${name} is a frontend variable name; the API token must stay on the server. Remove it.`)
  }

  const host = read(env, 'HOST') ?? '127.0.0.1'
  if (!LOOPBACK.includes(host)) errors.push(`HOST must be a loopback address (127.0.0.1, ::1 or localhost) (got "${host}"). Remote access needs TLS and authentication, which this server does not have yet.`)

  let port = 8787
  const rawPort = read(env, 'PORT')
  if (rawPort !== undefined) {
    if (/^\d+$/.test(rawPort) && Number(rawPort) <= 65535) port = Number(rawPort)
    else errors.push(`PORT must be an integer from 0 to 65535 (got "${rawPort}").`)
  }

  let allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']
  const rawOrigins = read(env, 'ALLOWED_ORIGINS')
  if (rawOrigins !== undefined) {
    const items = [...new Set(rawOrigins.split(',').map((o) => o.trim()).filter((o) => o !== ''))]
    if (items.length === 1 && items[0] === 'none') allowedOrigins = []
    else if (items.length > 16) errors.push('ALLOWED_ORIGINS lists more than 16 origins.')
    else {
      const problems: string[] = []
      for (const entry of items) {
        if (entry === '*' || entry === 'null') { problems.push(`ALLOWED_ORIGINS must list exact origins; "${entry}" is not allowed.`); continue }
        let url: URL
        try { url = new URL(entry) } catch { problems.push(`ALLOWED_ORIGINS entry "${entry}" is not a valid origin (expected something like http://localhost:5173).`); continue }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push(`ALLOWED_ORIGINS entry "${entry}" must use http or https.`)
        else if (url.origin !== entry) problems.push(`ALLOWED_ORIGINS entry "${entry}" must be an origin only, like ${url.origin}.`)
      }
      if (problems.length > 0) errors.push(...problems)
      else allowedOrigins = items
    }
  }

  const dataDir = resolve(cwd, read(env, 'DATA_DIR') ?? 'data')

  const rawRuntime = read(env, 'RUNTIME') ?? 'mock'
  if (rawRuntime !== 'mock' && rawRuntime !== 'claude') errors.push(`RUNTIME must be "mock" or "claude" (got "${rawRuntime}").`)

  // `max` is for values that become timers: Node treats a setTimeout above 2^31-1 ms as 1 ms, which would end every task at once.
  const positive = (name: string, fallback: number, max?: number): number => {
    const raw = read(env, name)
    if (raw === undefined) return fallback
    if (/^\d+$/.test(raw) && Number(raw) > 0) {
      if (max === undefined || Number(raw) <= max) return Number(raw)
      errors.push(`${name} must be at most ${max} ms, about 24 days (got "${raw.length > 24 ? `${raw.slice(0, 24)}…` : raw}").`)
      return fallback
    }
    errors.push(`${name} must be a positive integer (got "${raw}").`)
    return fallback
  }
  const taskTimeoutMs = positive('TASK_TIMEOUT_MS', 600000, MAX_TIMER_MS)
  const cancelGraceMs = positive('CANCEL_GRACE_MS', 5000, MAX_TIMER_MS)
  const approvalTimeoutMs = positive('APPROVAL_TIMEOUT_MS', 300000, MAX_TIMER_MS)
  const errorsBeforeBytes = errors.length
  const maxMessageBytes = positive('MAX_MESSAGE_BYTES', 32768)
  const maxTaskOutputBytes = positive('MAX_TASK_OUTPUT_BYTES', 262144)
  if (errors.length === errorsBeforeBytes && maxMessageBytes > maxTaskOutputBytes) errors.push('MAX_MESSAGE_BYTES must not exceed MAX_TASK_OUTPUT_BYTES.')
  const eventBufferSize = positive('EVENT_BUFFER_SIZE', 500)

  let auditLogMaxBytes = 5242880
  const rawAudit = read(env, 'AUDIT_LOG_MAX_BYTES')
  if (rawAudit !== undefined) {
    if (/^\d+$/.test(rawAudit) && Number(rawAudit) >= 65536 && Number(rawAudit) <= 1073741824) auditLogMaxBytes = Number(rawAudit)
    else errors.push(`AUDIT_LOG_MAX_BYTES must be from 65536 to 1073741824 (got "${rawAudit}").`)
  }

  let allowedTools = [...DEFAULT_ALLOWED_TOOLS]
  const rawTools = read(env, 'ALLOWED_TOOLS')
  if (rawTools !== undefined) {
    const items = rawTools.split(',').map((t) => t.trim()).filter((t) => t !== '')
    const known = TOOL_CATALOGUE.map((t) => t.name)
    const unknown = items.find((t) => !known.includes(t) && t !== 'none')
    if (items.some((t) => t === '*' || t.toLowerCase() === 'all')) errors.push(`ALLOWED_TOOLS must list tool names; "${rawTools.trim()}" is not allowed.`)
    else if (unknown !== undefined) errors.push(`ALLOWED_TOOLS has an unknown tool "${unknown}". Known tools: ${known.join(', ')}.`)
    else allowedTools = items.length === 1 && items[0] === 'none' ? [] : [...new Set(items)]
  }

  let apiToken: string | null = null
  const rawToken = read(env, 'API_TOKEN')
  if (rawToken !== undefined) {
    if (rawToken.length < MIN_TOKEN_CHARS || /\s/.test(rawToken)) errors.push(`API_TOKEN must be at least ${MIN_TOKEN_CHARS} characters with no spaces.`)
    else apiToken = rawToken
  }

  const ws = parseWorkspaces(read(env, 'WORKSPACE_ROOT'), read(env, 'WORKSPACES'), dataDir)
  errors.push(...ws.errors)

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: { host, port, dataDir, runtime: rawRuntime as RuntimeKind, taskTimeoutMs, cancelGraceMs, approvalTimeoutMs, maxMessageBytes, maxTaskOutputBytes, eventBufferSize, auditLogMaxBytes, workspaceRoot: ws.workspaceRoot, workspaces: ws.workspaces, allowedTools, allowedOrigins, credentialsConfigured: (read(env, 'ANTHROPIC_API_KEY') ?? '').trim() !== '', apiToken },
  }
}

/** Values from a .env file, with the real environment taking priority. */
export function mergeEnv(fileText: string | null, env: Env): Env {
  return { ...(fileText === null ? {} : parseEnv(fileText)), ...env }
}

export function formatConfigErrors(errors: string[]): string {
  return `Server config is invalid:\n${errors.map((e) => `- ${e}`).join('\n')}`
}

/** The config for this process: .env in the working directory (if any) plus the real environment. */
export function loadConfig(cwd: string = process.cwd(), env: Env = process.env): Parsed {
  let text: string | null = null
  try {
    text = readFileSync(resolve(cwd, '.env'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const merged = mergeEnv(text, env)
  const parsed = parseConfig(merged, cwd)
  // Self-check: the key may only ever reach the config as a flag.
  if (parsed.ok && findSecretInConfig(parsed.config, merged.ANTHROPIC_API_KEY)) return { ok: false, errors: ['Refusing to start: a secret value reached the server config.'] }
  return parsed
}
