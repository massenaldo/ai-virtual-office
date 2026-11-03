import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeAvailability, RuntimeEvent } from '../../src/workforce/runtime/types'
import type { AgentTask, ApprovalDecision } from '../../src/workforce/types'
import type { ClaudeSettings } from '../config'
import { silentLogger, type Logger } from '../log'
import type { Secret } from '../secret'
import { buildChildEnv } from './claudeEnv'
import { createMessageMapper, initProblem } from './claudeMessages'
import { createVoServer, MODEL_TOOL_NAMES, TOOL_LABELS, VO_SERVER_NAME, type SdkToolApi } from './claudeTools'
import { buildPrompt, buildSystemPrompt } from './claudePrompt'
import type { ExecutionResult, ExecutionStatus, ServerRuntimeProvider, StartContext, StartOutcome } from './types'

/**
 * The provider for the Claude Agent SDK. One `query()` and one SDK session per task.
 *
 * What the model can do (3B.5.3): answer in text and use five tools served by an in-process MCP server over the gated tool
 * handlers (claudeTools.ts): `vo_read`, `vo_glob` and `vo_grep` (read), and `vo_write` and `vo_edit` (change a file, each only
 * after a person approves exactly that change, unless a rule says otherwise). It cannot run anything.
 *
 * The server's permission engine is authoritative, not the SDK's. Every tool handler calls `ctx.tools.use`, so the policy,
 * the permission rules, the approval and the use-time re-check all happen in our process, right before the file operation. The
 * SDK is configured so it has nothing of its own to decide, and anything unexpected stops the task (fail closed):
 *  1. `tools: []` removes every built-in tool; `mcpServers` holds only our server and `strictMcpConfig` ignores every other source.
 *  2. `allowedTools` pre-approves exactly our five tools (the gate decides inside them); `dontAsk` denies everything else.
 *  3. The session's own `init` message must list exactly those tools, exactly our server, and the `dontAsk` mode, or the task
 *     fails before it starts.
 *  4. A `PreToolUse` hook denies any tool that is not ours; an assistant message that calls one ends the task.
 * See docs/milestone-3b5-planning.md section 8.
 *
 * Process: the SDK starts its bundled Claude Code binary as a child process; this file never starts a process itself. The child
 * gets an empty scratch folder as its working directory (never the workspace, which only the gated tools touch), a minimal
 * environment (claudeEnv.ts), no settings files, no stored session and no auto memory. Nothing the SDK says is forwarded as is:
 * see claudeMessages.ts.
 *
 * There is no OS-level isolation here. The child runs as the server's user; the workspace checks are policy, not a sandbox.
 */

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
/** How long the SDK may take to send its first message. */
const START_TIMEOUT_MS = 30000
const KEEP_ENDED = 200

/** A PreToolUse input for one of our own tools. Anything else, or anything malformed, is not. */
function isOurTool(input: unknown): boolean {
  const name = (input as { tool_name?: unknown } | null)?.tool_name
  return typeof name === 'string' && MODEL_TOOL_NAMES.includes(name)
}

/** Whether the SDK package can be found from here. The server starts without it and reports the runtime unavailable. */
export function isSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve(SDK_PACKAGE)
    return true
  } catch {
    return false
  }
}

/** Why the runtime is unavailable, or null when it is not. The SDK is checked first, then the credentials. */
export function claudeUnavailableReason(sdkInstalled: boolean, credentialsConfigured: boolean): string | null {
  if (!sdkInstalled) return 'Claude Agent SDK not installed'
  if (!credentialsConfigured) return 'credentials not configured'
  return null
}

/** What the provider needs from a started session. The SDK's `Query` satisfies it, and so does a fake in tests. */
export type SessionQuery = AsyncIterable<SDKMessage> & { close(): void }
export type QueryFn = (params: { prompt: string; options: Options }) => SessionQuery

export type ClaudeProviderOptions = {
  sdkInstalled?: boolean
  /** The Anthropic API key. Null or missing: the runtime is unavailable. */
  apiKey?: Secret | null
  settings?: ClaudeSettings
  /** The server's data folder: the scratch folders and the CLI's own state live inside it. */
  dataDir?: string
  /** Replaces the real SDK (tests). */
  query?: QueryFn
  log?: Logger
  startTimeoutMs?: number
  /** The environment PATH is taken from. */
  base?: Record<string, string | undefined>
  /** Real paths no tool may touch (the data folder). Required by the gated tools. */
  protectedRoots?: readonly string[]
  /** How long the SDK waits for one tool call. Must exceed the approval timeout, or the SDK gives up while the gate still waits. */
  toolTimeoutMs?: number
  /** Where the SDK's API calls go (a test seam for a local scripted API); null or absent means Anthropic's own endpoint. */
  apiBaseUrl?: string | null
}

type Outcome = 'running' | 'completed' | 'failed' | 'cancelled'
type SessionRecord = { executionId: string; sessionId: string | null; abort: AbortController; session: SessionQuery | null; outcome: Outcome; summary: string; error: string; cancelled: boolean; scratch: string; done: Promise<void> }

async function loadSdk(): Promise<{ query: QueryFn; api: SdkToolApi }> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return { query: sdk.query as unknown as QueryFn, api: sdk }
}

const DENY_UNKNOWN_TOOL = 'That tool is not available.'

export class ClaudeAgentRuntimeProvider implements ServerRuntimeProvider {
  readonly kind = 'claude' as const
  readonly availability: RuntimeAvailability
  private readonly apiKey: Secret | null
  private readonly settings: ClaudeSettings
  private readonly dataDir: string
  private readonly queryFn: QueryFn | null
  private readonly log: Logger
  private readonly startTimeoutMs: number
  private readonly base: NonNullable<ClaudeProviderOptions['base']>
  private readonly protectedRoots: readonly string[]
  private readonly toolTimeoutMs: number
  private readonly apiBaseUrl: string | null
  private readonly records = new Map<string, SessionRecord>()
  private readonly ended: string[] = []
  private readonly listeners = new Set<(event: RuntimeEvent) => void>()

  constructor(opts: ClaudeProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? null
    this.settings = opts.settings ?? { model: null, maxTurns: 12, maxBudgetUsd: 0.5 }
    this.dataDir = opts.dataDir ?? ''
    this.queryFn = opts.query ?? null
    this.log = opts.log ?? silentLogger
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS
    this.base = opts.base ?? process.env
    this.protectedRoots = opts.protectedRoots ?? []
    // Without an explicit value, long enough for the default approval timeout (5 minutes) plus a minute.
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 360000
    this.apiBaseUrl = opts.apiBaseUrl ?? null
    const reason = claudeUnavailableReason(opts.sdkInstalled ?? (opts.query !== undefined || isSdkInstalled()), this.apiKey !== null)
    this.availability = reason === null ? { available: true } : { available: false, reason }
  }

  async start(task: AgentTask, ctx: StartContext): Promise<StartOutcome> {
    if (!this.availability.available) return { ok: false, error: this.availability.reason }
    if (this.apiKey === null || this.dataDir === '') return { ok: false, error: 'Runtime failed to start.' }
    if (ctx.workspace === null) return { ok: false, error: 'The claude runtime needs a workspace.' }

    const taskId = task.id
    const executionId = randomUUID()
    const scratch = join(this.dataDir, 'claude-scratch', taskId)
    const configDir = join(this.dataDir, 'claude-config')
    const abort = new AbortController()
    const rec: SessionRecord = { executionId, sessionId: null, abort, session: null, outcome: 'running', summary: '', error: '', cancelled: false, scratch, done: Promise.resolve() }

    let run: QueryFn
    let server: ReturnType<typeof createVoServer>
    try {
      mkdirSync(scratch, { recursive: true, mode: 0o700 })
      mkdirSync(configDir, { recursive: true, mode: 0o700 })
      const sdk = await loadSdk()
      run = this.queryFn ?? sdk.query
      server = createVoServer(sdk.api, ctx, { protectedRoots: this.protectedRoots, timeoutMs: this.toolTimeoutMs })
    } catch (error) {
      this.log.error(`The Claude runtime could not prepare task ${taskId}`, error)
      rmSync(scratch, { recursive: true, force: true })
      return { ok: false, error: 'Runtime failed to start.' }
    }

    const options: Options = {
      abortController: abort,
      cwd: scratch,
      env: buildChildEnv({ apiKey: this.apiKey.reveal(), home: scratch, configDir, base: this.base, apiBaseUrl: this.apiBaseUrl }),
      tools: [],
      allowedTools: [...MODEL_TOOL_NAMES],
      mcpServers: { [VO_SERVER_NAME]: server },
      strictMcpConfig: true,
      permissionMode: 'dontAsk',
      // No canUseTool: under dontAsk the SDK denies anything not pre-approved without asking, so a callback would never run (and the SDK
      // warns that it will not). The PreToolUse hook below is the backstop, and it runs before every other step.
      hooks: { PreToolUse: [{ hooks: [(input) => Promise.resolve(isOurTool(input) ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_UNKNOWN_TOOL } })] }] },
      settingSources: [],
      persistSession: false,
      maxTurns: this.settings.maxTurns,
      maxBudgetUsd: this.settings.maxBudgetUsd,
      ...(this.settings.model !== null ? { model: this.settings.model } : {}),
      systemPrompt: buildSystemPrompt(ctx.agent),
      includePartialMessages: false,
      // The child's stderr can name paths and settings; none of it is kept.
      stderr: () => {},
    }

    let session: SessionQuery
    try {
      session = run({ prompt: buildPrompt(task), options })
    } catch (error) {
      this.log.error(`The Claude runtime could not start task ${taskId}`, error)
      rmSync(scratch, { recursive: true, force: true })
      return { ok: false, error: 'Runtime failed to start.' }
    }
    rec.session = session
    this.records.set(taskId, rec)
    if (ctx.signal.aborted) this.cancel(taskId)
    else ctx.signal.addEventListener('abort', () => this.cancel(taskId), { once: true })

    return new Promise<StartOutcome>((resolve) => {
      let ready = false
      const settle = (outcome: StartOutcome) => { if (!ready) { ready = true; clearTimeout(timer); resolve(outcome) } }
      const timer = setTimeout(() => {
        if (ready) return
        this.log.warn(`The Claude runtime sent nothing for task ${taskId} within ${this.startTimeoutMs} ms`)
        rec.cancelled = true
        settle({ ok: false, error: 'The Claude runtime did not start in time.' })
        this.stop(rec)
      }, this.startTimeoutMs)
      rec.done = this.consume(taskId, rec, ctx, settle, () => ready)
    })
  }

  /** Reads the session to its end. Everything the task manager hears about the session passes through here. */
  private async consume(taskId: string, rec: SessionRecord, ctx: StartContext, settle: (o: StartOutcome) => void, isReady: () => boolean): Promise<void> {
    const mapper = createMessageMapper(taskId, TOOL_LABELS)
    const session = rec.session!
    const finish = (outcome: Exclude<Outcome, 'running'>, event: RuntimeEvent | null, detail: { summary?: string; error?: string } = {}) => {
      if (rec.outcome !== 'running') return
      rec.outcome = outcome
      rec.summary = detail.summary ?? ''
      rec.error = detail.error ?? ''
      this.ended.push(taskId)
      while (this.ended.length > KEEP_ENDED) this.records.delete(this.ended.shift()!)
      if (event) this.emit(event)
    }
    // Before the first message there is no task event to send: the start outcome carries the failure to the task manager.
    const fail = (error: string) => { if (isReady()) finish('failed', { type: 'failed', taskId, error }, { error }); else { finish('failed', null, { error }); settle({ ok: false, error }) } }
    try {
      for await (const message of session) {
        if (rec.cancelled || rec.outcome !== 'running') continue
        const mapped = mapper.map(message)
        if (mapped.init) {
          const problem = initProblem(message, { tools: MODEL_TOOL_NAMES, mcpServers: [VO_SERVER_NAME] })
          if (problem !== null) {
            ctx.audit(`The Claude session was not started: ${problem}`)
            this.log.error(`The Claude session for task ${taskId} did not match the configuration: ${problem}`)
            fail('The Claude runtime started with an unexpected configuration.')
            this.stop(rec)
            continue
          }
          rec.sessionId = mapped.init.sessionId
          ctx.audit(`Claude session started (session ${rec.sessionId})`)
          this.emit({ type: 'started', taskId, executionId: rec.executionId, sessionId: rec.sessionId })
          settle({ ok: true, executionId: rec.executionId, sessionId: rec.sessionId })
          continue
        }
        if (mapped.note) ctx.audit(mapped.note)
        if (mapped.violation) {
          ctx.audit(mapped.violation)
          fail(mapped.violation)
          this.stop(rec)
          continue
        }
        if (!isReady()) {
          // A result before init: the session never started (for example the key was refused).
          if (mapped.terminal) {
            const failed = mapped.events.find((e): e is Extract<RuntimeEvent, { type: 'failed' }> => e.type === 'failed')
            if (mapped.usage) ctx.audit(`Claude session ended: ${mapped.usage}`)
            fail(failed ? failed.error : 'The Claude runtime ended before it started.')
          }
          continue
        }
        for (const event of mapped.events) {
          if (event.type === 'completed') finish('completed', event, { summary: event.summary })
          else if (event.type === 'failed') finish('failed', event, { error: event.error })
          else this.emit(event)
        }
        if (mapped.terminal && mapped.usage) ctx.audit(`Claude session ended: ${mapped.usage}`)
      }
      if (rec.outcome === 'running') {
        if (rec.cancelled) { finish('cancelled', { type: 'cancelled', taskId }); settle({ ok: true, executionId: rec.executionId, sessionId: rec.sessionId }) }
        else fail('The Claude runtime ended without a result.')
      }
    } catch (error) {
      // After a result the SDK may still throw its own error for it; after our own abort it throws an abort error.
      if (rec.outcome === 'running') {
        if (rec.cancelled) { finish('cancelled', { type: 'cancelled', taskId }); settle({ ok: true, executionId: rec.executionId, sessionId: rec.sessionId }) }
        else {
          this.log.error(`The Claude session for task ${taskId} failed`, error)
          fail('The Claude runtime stopped with an error.')
        }
      }
    } finally {
      this.stop(rec)
      rmSync(rec.scratch, { recursive: true, force: true })
    }
  }

  /** Ends the session and its child process. Safe to call more than once. */
  private stop(rec: SessionRecord): void {
    rec.abort.abort()
    try { rec.session?.close() } catch { /* already closed */ }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  cancel(taskId: string): void {
    const rec = this.records.get(taskId)
    if (!rec || rec.outcome !== 'running' || rec.cancelled) return
    rec.cancelled = true
    this.stop(rec)
  }

  status(taskId: string): ExecutionStatus {
    const rec = this.records.get(taskId)
    if (!rec) return { state: 'unknown' }
    if (rec.outcome === 'running') return { state: 'running', executionId: rec.executionId, sessionId: rec.sessionId, pendingApprovalId: null }
    return { state: 'ended', executionId: rec.executionId, outcome: rec.outcome }
  }

  result(taskId: string): ExecutionResult | null {
    const rec = this.records.get(taskId)
    if (!rec || rec.outcome === 'running') return null
    if (rec.outcome === 'completed') return { outcome: 'completed', summary: rec.summary }
    if (rec.outcome === 'failed') return { outcome: 'failed', error: rec.error }
    return { outcome: 'cancelled' }
  }

  /** There are no tools in this stage, so there is never an approval for the runtime to wait on. */
  respondToApproval(_taskId: string, _approvalId: string, _decision: ApprovalDecision): void {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    const all = [...this.records.values()]
    for (const rec of all) if (rec.outcome === 'running') { rec.cancelled = true; this.stop(rec) }
    // Every session, also the ones that already ended: their scratch folder is removed when the SDK's output ends.
    await Promise.allSettled(all.map((r) => r.done))
    this.listeners.clear()
  }
}
