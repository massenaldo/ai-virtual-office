# Agent Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import agents from `<workspace>/.claude/agents/*.md` with a preview and confirmation, and re-import changes to a file's own fields.

**Architecture:** A pure parser plus a narrow read-only reader on the server. The server always re-reads the file at confirmation, and refuses if it changed since the preview. The browser sends only choices, never file content. The UI appears only in server-backed mode.

**Tech Stack:** TypeScript, Node `fs`, `node:crypto`, React, Vitest. No YAML library.

**Spec:** `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`, sections 4 and 6.3.

## Global Constraints

- A file grants nothing. `tools`, `permissionMode` and every other unknown field are ignored and listed as ignored. No file is ever executed, and no permission rule is ever created.
- Accepted frontmatter: `name`, `description`, `model`. The body becomes `instructions`.
- `sourceFile` format: `<workspaceId>:<fileName>`, for example `sandbox:backend-engineer.md`. It is set only by the server.
- A first import always creates a new agent. A re-import changes only `description`, `model` and `instructions`, and never `name`, `role`, `department` or the desk.
- Limits: 50 files per folder, 65536 bytes per file (`FILE_READ_MAX_BYTES`). Use the existing `AGENT_DESCRIPTION_MAX`, `AGENT_INSTRUCTIONS_MAX`, `NAME_MAX`, `ROLE_MAX` and `MODEL_NAME_PATTERN`.
- Real paths never leave the server: responses and logs use workspace ids and file names only.
- File content must never appear in the audit log or application log.
- No new dependencies. Never read, print or ask for an API key. Do not run `scripts/claudeRealRun.ts`. Do not read or change the owner's `data/`.

## Review Focus

1. A symlinked `.claude`, `.claude/agents` or `*.md` that points outside the workspace is refused and its content is never returned.
2. A hostile file: frontmatter `tools: [Bash]`, `permissionMode: bypassPermissions`, a `name` containing a line break, instructions telling the model to ignore its rules, or a bidi override hiding text. Nothing is granted, and the fixed rules stay first.
3. The file changes between preview and confirmation: the confirmation is refused with 409, and nothing is created.
4. A Windows line-ending file, a byte order mark and a block-style `description: >` all parse as a person would expect.
5. No workspaces configured, no `.claude/agents` folder, or an empty folder: a plain message, not an error page.

---

### Task 1: Parser, reader and name safety

**Files:**
- Create: `server/agentImport/parse.ts`, `server/agentImport/reader.ts`
- Test: `server/agentImport/parse.test.ts`, `server/agentImport/reader.test.ts`, `src/workforce/operations.test.ts`
- Modify: `src/workforce/operations.ts` (`validateAgentInput`), `server/toolPolicy.ts` (export)

**Interfaces:**
- Consumes: `redactSecrets` from `server/redact.ts`, `openInside` and `readTextFile` from `server/fileOps.ts`.
- Produces:
  - `export function hasUnsafeText(text: string): boolean` in `server/toolPolicy.ts`, wrapping the existing `UNSAFE_TO_SHOW`.
  - `export type ParsedAgentFile = { name: string; description: string; model: string | null; instructions: string; ignoredFields: string[]; descriptionCut: boolean; secretsMasked: boolean }`
  - `export function parseAgentFile(text: string): { ok: true; agent: ParsedAgentFile } | { ok: false; error: string }` in `parse.ts`.
  - `export function suggestedRole(fileName: string): string` in `parse.ts`.
  - `export type AgentFile = { file: string; digest: string } & ({ ok: true; agent: ParsedAgentFile } | { ok: false; error: string })`
  - `export function readAgentFiles(workspacePath: string, signal: AbortSignal): { folder: 'found' | 'missing'; files: AgentFile[]; cut: boolean }` and `export function readAgentFile(workspacePath: string, fileName: string, signal: AbortSignal): AgentFile | null` in `reader.ts`.

- [ ] **Step 1: Write failing tests**

`parseAgentFile`:
- Plain, single-quoted and double-quoted values all give `name: 'Forge'`.
- `description: >` and `description: |` with indented continuation lines: the folded form joins with spaces, the literal form keeps newlines.
- A leading byte order mark and CRLF line endings parse the same as LF, and no `\r` remains anywhere in the result.
- `tools: [Bash]`, `permissionMode: bypassPermissions` and any other key appear in `ignoredFields`, by key name only, and have no other effect. Indented lines under an ignored key are not read as keys.
- `model: inherit` gives `model: null`. `model: sonnet` gives `'sonnet'`. No model gives `null`. A value failing `MODEL_NAME_PATTERN` gives a per-file error.
- Description over `AGENT_DESCRIPTION_MAX` is cut to the limit with `descriptionCut: true`.
- These each give `ok: false` with a plain sentence: no opening `---`, no closing `---`, missing or blank `name`, `name` over `NAME_MAX`, the same accepted key twice, instructions over `AGENT_INSTRUCTIONS_MAX` (never cut), and any accepted value or the body failing `hasUnsafeText` or containing a control character.
- A secret-shaped value in the body or description comes back as `[REDACTED]`, with `secretsMasked: true`.

`suggestedRole`: `backend-engineer.md` gives `Backend engineer`, `qa_lead.md` gives `Qa lead`, and a very long name is capped at `ROLE_MAX`.

`readAgentFiles`, using real temporary folders:
- Returns `folder: 'missing'` when `.claude/agents` does not exist.
- Lists only `*.md` files directly in the folder, sorted. Subfolders are skipped. A name outside `/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/` becomes a per-file error.
- A symlinked `.claude`, symlinked `agents` folder or symlinked file is refused and its content is not returned. A hard-linked file (`nlink > 1`) is refused. A file over 65536 bytes is a per-file error.
- More than 50 files gives the first 50 with `cut: true`.
- `digest` is the SHA-256 hex of the exact file bytes, and changes when the file changes.

`validateAgentInput`: a `name` or `role` containing a newline, tab or control character is refused.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run server/agentImport src/workforce/operations.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

The parser is line based: read top-level `key: value` lines between the `---` markers, and treat a more-indented line as belonging to the key above it. The reader walks `.claude`, then `agents`, with `lstat`, refusing anything that is not a real directory, lists with `readdirSync(..., { withFileTypes: true })`, and opens files through the existing `openInside` or `readTextFile` so their checks apply. It calls no other path and never takes a path from the caller beyond a validated file name.

- [ ] **Step 4: Run the tests and commit**

Run: `npx tsc -b && npx vitest run server/agentImport src/workforce/operations.test.ts`
Expected: PASS.

```bash
git add server/agentImport server/toolPolicy.ts src/workforce/operations.ts src/workforce/operations.test.ts
git commit -m "feat(server): read and parse agent files without trusting them"
```

### Task 2: Import routes

**Files:**
- Modify: `src/workforce/operations.ts`, `src/workforce/api.ts`, `server/http/routes.ts`, `server/http/inputs.ts`, `server/audit.ts`
- Test: the server's route tests, `src/workforce/operations.test.ts`, and a new end-to-end case proving no permission rule changes

**Interfaces:**
- Consumes: `readAgentFiles`, `readAgentFile`, `suggestedRole`, `AgentFile` from Task 1.
- Produces:
  - `createAgent` gains `opts.sourceFile?: string`.
  - `GET /api/workspaces/:id/agent-files` returns `AgentFilesResponse = { folder: 'found' | 'missing'; cut: boolean; files: AgentFilePreview[] }`, where `AgentFilePreview` is an `AgentFile` plus, when `ok`, `suggestedRole: string` and `existing: { agentId: string; changes: ('description' | 'model' | 'instructions')[] } | null`.
  - `POST /api/agents/import`, body `{ workspaceId, file, digest, role, department }`, returns 201 with the agent.
  - `POST /api/agents/:id/reimport`, body `{ digest }`, returns 200 with the agent.

- [ ] **Step 1: Write failing tests**

- Preview: an unknown or badly formed workspace id gives 404 and reveals no path. A file already imported has `existing` with the fields that differ.
- Import: creates an agent with `sourceFile` set, `name`, `description`, `model` and `instructions` from a **fresh read of the file**, and `role` and `department` from the body. The closed field list refuses `name`, `instructions`, `model` and `sourceFile` in the body with 400. A changed file (`digest` mismatch) gives 409 and creates nothing. A second import of the same file gives 409 and names the existing agent. A bad `department` or `role` gives 422. A file that fails parsing gives 422.
- Re-import: changes only `description`, `model` and `instructions`. A manually edited `name`, `role`, `department` and the desk stay as they are. An agent without `sourceFile` gives 409. A missing file or workspace gives 404 with a plain sentence. A changed file gives 409.
- With hostile frontmatter (`tools`, `permissionMode`), the permission rules before and after are identical, and the imported agent's Write still needs approval.
- The system prompt for an agent imported from a hostile file begins with the fixed rules, using the real `buildSystemPrompt`.
- An `agent.imported` or `agent.reimported` audit record holds the workspace id, agent id, file name and the first 12 characters of the digest, and no file content.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run server/http src/workforce/operations.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

Follow the existing route patterns and `store.commit`. Resolve the workspace with `resolveWorkspace` on every request. Re-import goes through `updateAgent`, with a patch of the three fields only. Parse `sourceFile` by splitting at the first `:`.

- [ ] **Step 4: Run the tests and commit**

Run: `npx tsc -b && npx vitest run`
Expected: all pass. Report the counts.

```bash
git add -A src server
git commit -m "feat(server): preview, import and re-import agents from agent files"
```

### Task 3: Import screen and documentation

**Files:**
- Create: `src/workforce/ui/ImportAgents.tsx`, `src/workforce/ui/ImportAgents.test.tsx`
- Modify: `src/workforce/ui/WorkforcePanel.tsx`, `src/workforce/ui/AgentList.tsx`, `src/workforce/ui/AgentDetail.tsx`, `src/workforce/remote/commands.ts`, `src/workforce/remote/remoteController.ts`, `src/workforce/view.ts`, `src/styles.css`, `README.md`, `.env.example`, `MASTER-ROADMAP.md`, `docs/superpowers/specs/2026-11-06-office-presence-daily-life-design.md`
- Test: `src/workforce/remote/commands.test.ts`, `src/workforce/view.test.ts`

**Interfaces:**
- Consumes: the three routes from Task 2, and `snapshot.workspaces` (`string[] | null`, null in browser mode).
- Produces: `WorkforceView` gains `{ kind: 'import' }`. Optional actions `listAgentFiles(workspaceId)`, `importAgent(body)`, `reimportAgent(agentId, digest)`, following the pattern of the permission commands and absent in browser mode.

- [ ] **Step 1: Write failing tests**

- Browser mode (`workspaces` null): the import view says "Importing agents needs the server. Start the app with npm run dev:full." and calls nothing.
- No workspaces (`[]`): it says "No workspace is set up yet. Set WORKSPACE_ROOT and WORKSPACES in .env and restart the server."
- Missing folder: "This workspace has no .claude/agents folder." Empty: "No agent files found in .claude/agents."
- A good file shows name, description, model or "Server default", the full instructions in a scrolling block, "Ignored: tools, permissionMode" when there are ignored fields, and a notice if a secret was masked or the description was cut. It has a Role input seeded from `suggestedRole`, and a required Department select with **no default**. Import stays disabled until a department is chosen.
- A bad file shows its error and offers no import.
- An already imported file offers **Re-import** instead, listing the changing fields, and "No changes" with no button when there are none. Re-import asks for confirmation through `openDialog`, saying that the name, role, department and desk stay as they are.
- A 409 from a changed file shows "This file changed since the preview. Load it again." and refreshes the list.
- `AgentDetail` shows "Imported from <fileName>" for an agent with `sourceFile`.
- The remote commands send the right method, URL and body, including `encodeURIComponent` on the workspace id.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/workforce/ui/ImportAgents.test.tsx src/workforce/remote/commands.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Implement**

Put an "Import agents" link next to the existing create action in `AgentList`. Use the existing `field`, `panel-button`, `panel-link` and `form-error` patterns. Show instructions as plain text, never as HTML.

- [ ] **Step 4: Update the documents**

- README: a short "Import agents from role files" section covering the folder, the `.env` workspace settings, what is read and ignored, and that re-import never changes name, role, department or desk.
- `.env.example`: mention import under `WORKSPACES` if it helps a reader.
- `MASTER-ROADMAP.md` M3B.6: mark the import item as done, and tick the acceptance line that import is read-only and cannot grant tools or permissions. Presence stays open.
- Spec, section 5: replace "and the agent's gated tools must keep treating it that way" with "for writes; the agent's gated tools can read that folder today, and this design does not change that". Section 6.3: replace "The agent's own `vo_*` tools still cannot read that folder." with "This does not change what the agent's own `vo_*` tools may do with that folder."

- [ ] **Step 5: Run everything**

Run: `npm run build && npx vitest run && npm run server:build && npm run check:secrets`
Expected: all pass. Report the counts.

- [ ] **Step 6: See it in real Chrome, on temporary data**

Run `npm run dev:full` with a temporary `DATA_DIR`, `WORKSPACE_ROOT` and `WORKSPACES` under the scratchpad, holding one good file, one hostile file with `tools` and `permissionMode`, and one broken file. Import the good one with a real department choice, and confirm the agent appears and the preview shows ignored fields. Edit the file, re-import, and confirm only the file's fields changed. Check that Permissions shows no new rule. Stop the server and remove the folders. Report what you saw.

- [ ] **Step 7: Commit**

```bash
git add -A src README.md .env.example MASTER-ROADMAP.md docs/superpowers/specs
git commit -m "feat(workforce): import agents from role files in the panel"
```
