import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

export type RuntimeKind = 'mock' | 'claude'

export type ServerConfig = { host: string; port: number; dataDir: string; runtime: RuntimeKind; taskTimeoutMs: number; cancelGraceMs: number; approvalTimeoutMs: number; maxMessageBytes: number; maxTaskOutputBytes: number; eventBufferSize: number; credentialsConfigured: boolean }

export type Env = Record<string, string | undefined>

type Parsed = { ok: true; config: ServerConfig } | { ok: false; errors: string[] }

const LOOPBACK = ['127.0.0.1', '::1', 'localhost']

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

  const host = read(env, 'HOST') ?? '127.0.0.1'
  if (!LOOPBACK.includes(host)) errors.push(`HOST must be a loopback address (127.0.0.1, ::1 or localhost) until origin checks are added (got "${host}").`)

  let port = 8787
  const rawPort = read(env, 'PORT')
  if (rawPort !== undefined) {
    if (/^\d+$/.test(rawPort) && Number(rawPort) <= 65535) port = Number(rawPort)
    else errors.push(`PORT must be an integer from 0 to 65535 (got "${rawPort}").`)
  }

  const dataDir = resolve(cwd, read(env, 'DATA_DIR') ?? 'data')

  const rawRuntime = read(env, 'RUNTIME') ?? 'mock'
  if (rawRuntime !== 'mock' && rawRuntime !== 'claude') errors.push(`RUNTIME must be "mock" or "claude" (got "${rawRuntime}").`)

  const positive = (name: string, fallback: number): number => {
    const raw = read(env, name)
    if (raw === undefined) return fallback
    if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw)
    errors.push(`${name} must be a positive integer (got "${raw}").`)
    return fallback
  }
  const taskTimeoutMs = positive('TASK_TIMEOUT_MS', 600000)
  const cancelGraceMs = positive('CANCEL_GRACE_MS', 5000)
  const approvalTimeoutMs = positive('APPROVAL_TIMEOUT_MS', 300000)
  const errorsBeforeBytes = errors.length
  const maxMessageBytes = positive('MAX_MESSAGE_BYTES', 32768)
  const maxTaskOutputBytes = positive('MAX_TASK_OUTPUT_BYTES', 262144)
  if (errors.length === errorsBeforeBytes && maxMessageBytes > maxTaskOutputBytes) errors.push('MAX_MESSAGE_BYTES must not exceed MAX_TASK_OUTPUT_BYTES.')
  const eventBufferSize = positive('EVENT_BUFFER_SIZE', 500)

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    config: { host, port, dataDir, runtime: rawRuntime as RuntimeKind, taskTimeoutMs, cancelGraceMs, approvalTimeoutMs, maxMessageBytes, maxTaskOutputBytes, eventBufferSize, credentialsConfigured: (read(env, 'ANTHROPIC_API_KEY') ?? '').trim() !== '' },
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
  return parseConfig(mergeEnv(text, env), cwd)
}
