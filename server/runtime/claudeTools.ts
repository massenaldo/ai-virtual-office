import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createGatedTools, type ToolResult } from '../tools/gatedTools'
import type { StartContext } from './types'

// The model-facing side of the gated tools (3B.5.3: three reads and two writes). Each tool is a thin shell over the handlers in
// server/tools/gatedTools.ts, which go only through `ctx.tools.use`: the server's policy, permission rules, approval and use-time
// re-check decide, never the SDK. The schemas below only describe the tools to the model and reject the wrong shape early; the
// handlers validate again before anything is asked of the gate.

/** The name of our in-process MCP server. The SDK prefixes every one of its tools with `mcp__<server>__`. */
export const VO_SERVER_NAME = 'vo'

/** What the model calls each tool, and the short text a person sees while it runs. Nothing about the input is ever shown. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  [`mcp__${VO_SERVER_NAME}__vo_read`]: 'Reading a file',
  [`mcp__${VO_SERVER_NAME}__vo_glob`]: 'Listing files',
  [`mcp__${VO_SERVER_NAME}__vo_grep`]: 'Searching files',
  [`mcp__${VO_SERVER_NAME}__vo_write`]: 'Writing a file',
  [`mcp__${VO_SERVER_NAME}__vo_edit`]: 'Editing a file',
}
export const MODEL_TOOL_NAMES: readonly string[] = Object.keys(TOOL_LABELS)

/** The two SDK functions this file needs. They are passed in so the SDK is loaded only when the claude runtime is used. */
export type SdkToolApi = Pick<typeof Sdk, 'tool' | 'createSdkMcpServer'>

/** A tool result in the shape MCP wants. A refusal is an error result the model can read; the text is always a fixed sentence or bounded, redacted file data. */
export function toCallToolResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  return { content: [{ type: 'text', text: result.text }], ...(result.ok ? {} : { isError: true as const }) }
}

// Reads need no approval by default, have no side effects and may run side by side.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
// Writes change files, so the SDK runs them one at a time; each one waits for a person unless a rule says otherwise.
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const

export function createVoServer(sdk: SdkToolApi, ctx: Pick<StartContext, 'tools'>, opts: { protectedRoots: readonly string[]; timeoutMs: number }) {
  const tools = createGatedTools(ctx, { protectedRoots: opts.protectedRoots })
  const positive = z.number().int().positive()

  const read = sdk.tool(
    'vo_read',
    'Read a text file in the workspace. file_path is relative to the workspace root: no leading slash and no "..". Returns at most 64 KiB; use offset and limit (line numbers, starting at 1) to read further. Secrets in the text are masked.',
    { file_path: z.string(), offset: positive.optional(), limit: positive.optional() },
    async (args) => toCallToolResult(await tools.vo_read(args)),
    { annotations: READ_ONLY },
  )
  const glob = sdk.tool(
    'vo_glob',
    'List the files in the workspace whose path matches a glob pattern, for example "src/**/*.ts". path is an optional directory relative to the workspace root (default: the root). Returns at most 500 paths.',
    { pattern: z.string(), path: z.string().optional() },
    async (args) => toCallToolResult(await tools.vo_glob(args)),
    { annotations: READ_ONLY },
  )
  const grep = sdk.tool(
    'vo_grep',
    'Search the workspace for a fixed string (not a regular expression). path is an optional directory relative to the workspace root, glob an optional file filter such as "*.ts", "-i" ignores case, output_mode is "files_with_matches" (default) or "content". Returns at most 200 matches.',
    { pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), '-i': z.boolean().optional(), output_mode: z.enum(['files_with_matches', 'content']).optional() },
    async (args) => toCallToolResult(await tools.vo_grep(args)),
    { annotations: READ_ONLY },
  )

  const write = sdk.tool(
    'vo_write',
    'Create or overwrite a text file in the workspace with the given content. file_path is relative to the workspace root. A person reads the whole content and must approve every write, and may refuse, so write the complete file you intend. Content is limited to 32 KiB and must not contain secrets or control characters.',
    { file_path: z.string(), content: z.string() },
    async (args) => toCallToolResult(await tools.vo_write(args)),
    { annotations: WRITES },
  )
  const edit = sdk.tool(
    'vo_edit',
    'Replace text in an existing file in the workspace. file_path is relative to the workspace root. old_string must match the file exactly and appear once, unless replace_all is true. A person reads the whole change and must approve every edit, and may refuse. The old and new text together are limited to 32 KiB.',
    { file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
    async (args) => toCallToolResult(await tools.vo_edit(args)),
    { annotations: WRITES },
  )

  // `timeout` is how long the SDK waits for one call. It must be longer than a person may take to approve, or the SDK gives up
  // while the gate is still waiting; the approval timer (which fails the task) is what really bounds the wait.
  return sdk.createSdkMcpServer({ name: VO_SERVER_NAME, tools: [read, glob, grep, write, edit], alwaysLoad: true, timeout: opts.timeoutMs })
}
