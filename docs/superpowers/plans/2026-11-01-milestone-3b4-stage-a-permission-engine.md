# Milestone 3B.4 Stage A: Permission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, tested permission engine and its own persistence file, plus new audit fields, ready for the gate to use in stage B. Nothing is wired into the running app in this stage.

**Architecture:** `server/permissions/` holds rule types, a path-pattern matcher, a pure `evaluate` function, grant validation, JSON (de)serialisation and a store with the same read-op-commit and atomic-write style as `server/store.ts`. The store is synchronous (single Node thread), which is what makes `consumeOnce` atomic. Any error in evaluation yields `deny`.

**Tech Stack:** TypeScript, Node `node:fs`/`node:crypto`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md` (sections 4.1, 4.3, 4.5 audit, 6).

## Global Constraints

- Branch `feat/3b4-a-permission-engine` from up-to-date `main`; conventional commits ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Precedence: explicit deny, then most specific allow/ask (once, task, agent, global), then default deny. Fail closed: any error means `deny`, never allow.
- Execute and network tools (`Bash`, `WebFetch`, `WebSearch`) can be granted `allow` only at scope `once`.
- Seeded global defaults: `Read`, `Glob`, `Grep` allow; `Write`, `Edit` ask; `Bash`, `WebFetch`, `WebSearch` deny. (Consequence, by spec: a default deny blocks a once-grant until a person revokes that default.)
- Rules live in `DATA_DIR/permissions.json`, never in `workforce.json`; written atomically; a corrupt or newer-version file loads as defaults only plus a reported problem, and is backed up, never treated as allow-all.
- Audit records carry ids and codes only, never paths or request bodies.
- No change to `toolGate.ts`, `taskManager.ts`, routes, the frontend, config or `noProcessExecution.test.ts`. No `child_process`, no SDK, no Docker.
- Tests: vitest, files beside the code as `*.test.ts`, temp dirs via `mkdtempSync(join(tmpdir(), 'vo-perm-'))`, logger from `server/log.ts` (`silentLogger`, `recordingLogger`).
- Verification per task: `npx vitest run <file>`; at the end `npm test`, `npx tsc -b`, `npm run build`, `npm run check:secrets`.

## Review Focus

1. **Case-insensitive file systems (macOS):** a deny pattern `secrets/**` must also deny `SECRETS/key`. Deny patterns match case-insensitively, allow patterns case-sensitively. Pinned in Task 1.
2. **Unicode normalisation:** `café` typed as NFD must match an NFC pattern. Both sides are NFC-normalised before matching. Pinned in Task 1.
3. **Path-less calls against a path-restricted deny:** `Grep` or `Glob` with no path searches the whole workspace, so a deny rule with a `pathPattern` must still match (fail closed); an allow rule with a `pathPattern` must not. Pinned in Task 2.
4. **Pattern abuse:** `..`, absolute, `~`, backslash, brackets/braces, empty segments and 200+ character patterns are rejected; a 199-character pattern full of `**` finishes in well under 100 ms. Pinned in Task 1.
5. **Once-grant double use and corrupt file:** two `consumeOnce` calls on one rule give `true` then `false`; consume after revoke gives `false`; a corrupt `permissions.json` never yields an allow rule beyond the seeded defaults. Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/permissions/types.ts` (create) | All shared types and limits. No logic. |
| `server/permissions/pathPattern.ts` (create) | Validate and match workspace-relative patterns. |
| `server/permissions/engine.ts` (create) | `ruleState`, `evaluate`, `validateGrant`. Pure. |
| `server/permissions/defaults.ts` (create) | `defaultRules(now)`. |
| `server/permissions/storage.ts` (create) | `serializePermissions`, `parsePermissions`. |
| `server/permissions/store.ts` (create) | `openPermissionStore`. |
| `server/audit.ts` (modify) | New actions and fields. |
| `server/permissions/*.test.ts`, `server/audit.test.ts` | Tests. |

---

### Task 1: Types and path-pattern matcher

**Files:**
- Create: `server/permissions/types.ts`, `server/permissions/pathPattern.ts`
- Test: `server/permissions/pathPattern.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type PermissionScope = 'global' | 'agent' | 'task' | 'once'
  export type PermissionEffect = 'allow' | 'deny' | 'ask'
  export type PermissionState = 'active' | 'expired' | 'revoked' | 'used' | 'ended'
  export type PermissionRule = { id: string; scope: PermissionScope; effect: PermissionEffect; tool: string; agentId: string | null; taskId: string | null; pathPattern: string | null; digest: string | null; createdAt: string; createdBy: 'default' | 'user' | 'system'; expiresAt: string | null; revokedAt: string | null; usedAt: string | null; endedAt: string | null; reason: string | null }
  export type GrantInput = { scope: PermissionScope; effect: PermissionEffect; tool: string; agentId?: string | null; taskId?: string | null; pathPattern?: string | null; digest?: string | null; expiresAt?: string | null; reason?: string | null; createdBy?: 'user' | 'system' }
  export type PermissionQuery = { agentId: string; taskId: string; tool: string; digest: string; paths: readonly string[] }  // paths: workspace-relative, as CheckedPath.relative
  export type PermissionDecision = { effect: PermissionEffect; source: 'deny_rule' | 'once' | 'task' | 'agent' | 'global' | 'default' | 'error'; ruleId: string | null }
  export type GrantError = 'unknown_tool' | 'invalid_scope' | 'invalid_effect' | 'missing_agent' | 'missing_task' | 'missing_digest' | 'scope_not_allowed_for_tool' | 'invalid_pattern' | 'invalid_expiry' | 'invalid_reason'
  export const PATTERN_MAX_CHARS = 200, REASON_MAX_CHARS = 200
  ```
- Produces (`pathPattern.ts`): `isValidPathPattern(pattern: string): boolean` and `matchesPathPattern(pattern: string, relative: string, caseSensitive: boolean): boolean`.

- [ ] **Step 1: Create the branch** — `git checkout main && git pull --ff-only && git checkout -b feat/3b4-a-permission-engine`.
- [ ] **Step 2: Write `pathPattern.test.ts` (failing)** with these cases:
  - valid: `src/**`, `*.md`, `docs/*/index.md`, `a?c.txt`, `**/*.ts`.
  - invalid (each `isValidPathPattern(p) === false`): `''`, `'/etc/**'`, `'~/x'`, `'../x'`, `'a/../b'`, `'a\\b'`, `'a//b'`, `'a/'`, `'{a,b}'`, `'[ab]'`, `'(x)'`, `'a\u0000b'`, `'x'.repeat(201)`.
  - matches: `src/**` matches `src/a.ts`, `src/a/b/c.ts` and `src` is **not** matched by `src/**`? Decide: `**` matches zero or more whole segments, so `src/**` matches `src/a.ts` and `src/a/b` but not `src`. `*.md` matches `a.md` but not `a/b.md`. `a?c.txt` matches `abc.txt` not `ac.txt`. `**/*.ts` matches `x.ts` and `a/b/x.ts`.
  - case: `matchesPathPattern('secrets/**', 'SECRETS/key', false) === true`; `matchesPathPattern('secrets/**', 'SECRETS/key', true) === false`.
  - Unicode: `matchesPathPattern('café/*', 'café/x', true) === true`.
  - speed: pattern `Array(40).fill('**').join('/') + '/z'` (under 200 chars) against a 60-segment path of `a` finishes in under 100 ms (`performance.now()`).
- [ ] **Step 3: Run it, expect FAIL** — `npx vitest run server/permissions/pathPattern.test.ts` fails on a missing module.
- [ ] **Step 4: Implement `types.ts` and `pathPattern.ts`.** Matching works on `/`-split segments after NFC normalisation of both sides; a segment of exactly `**` matches zero or more path segments, other segments use an iterative `*`/`?` wildcard matcher (no regular expressions). Use memoised dynamic programming over (pattern index, path index) so cost is bounded by pattern length times path length. When `caseSensitive` is false, lower-case both sides after normalisation. `isValidPathPattern` rejects everything in the invalid list above, plus any control character and any `..` substring.
- [ ] **Step 5: Run it, expect PASS** — same command.
- [ ] **Step 6: Commit** — `git add server/permissions && git commit -m "feat(server): add permission types and a safe path-pattern matcher"` (with trailer).

---

### Task 2: Engine — rule state, evaluation, grant validation

**Files:**
- Create: `server/permissions/engine.ts`
- Test: `server/permissions/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `matchesPathPattern`/`isValidPathPattern`; `TOOL_CATALOGUE` from `server/toolPolicy.ts` (category per tool).
- Produces:
  ```ts
  export function ruleState(rule: PermissionRule, now: string): PermissionState   // precedence: revoked, used, ended, expired (now >= expiresAt), else active
  export function evaluate(rules: readonly PermissionRule[], query: PermissionQuery, now: string): PermissionDecision
  export function validateGrant(input: GrantInput, now: string): { ok: true; fields: Omit<PermissionRule, 'id' | 'createdAt' | 'revokedAt' | 'usedAt' | 'endedAt'> } | { ok: false; error: GrantError }
  ```

Matching rules for `evaluate` (only `active` rules are considered): `rule.tool === query.tool`; `rule.agentId` null or equal; `rule.taskId` null or equal; a `once` rule also needs `rule.digest === query.digest`. Path rules: a rule with a `pathPattern` — **allow/ask** matches only if `query.paths` is non-empty and every path matches (case-sensitive); **deny** matches if `query.paths` is empty (fail closed) or any path matches (case-insensitive). Decision: any matching deny gives `{effect:'deny', source:'deny_rule'}`; otherwise the first scope in the order once, task, agent, global with a match decides, and within that scope `ask` beats `allow`; nothing matches gives `{effect:'deny', source:'default', ruleId:null}`. Wrap the body in try/catch returning `{effect:'deny', source:'error', ruleId:null}`.

`validateGrant` rules: tool must exist in `TOOL_CATALOGUE`; `global` takes no agentId/taskId; `agent` needs `agentId`; `task` needs both; `once` needs both and a 64-hex `digest`, effect `allow` only, and no `pathPattern`; `ask` only at `global`/`agent`; execute/network tools may be `allow` only at `once`; `pathPattern` must pass `isValidPathPattern`; `expiresAt` must parse as an ISO date strictly after `now`; `reason` at most `REASON_MAX_CHARS`; `createdBy` defaults to `'user'`.

- [ ] **Step 1: Write `engine.test.ts` (failing)** with a small `rule(overrides)` factory and these tests (name → assertion):
  - `deny beats allow at every scope`: global deny + once allow with matching digest → `{effect:'deny', source:'deny_rule'}`.
  - `agent beats global`: global ask Write + agent allow Write → allow, `source:'agent'`; global allow + agent ask → ask.
  - `task beats agent, once beats task` (decision `source` and `ruleId` asserted).
  - `ask beats allow inside one scope`.
  - `nothing matches is default deny`.
  - `other agent's and other task's rules do not match`.
  - `once needs the exact digest`: different digest → default deny.
  - `revoked, used, ended and expired rules are ignored`; boundary `expiresAt === now` is expired, one millisecond earlier is active.
  - `deny with pathPattern and no query paths still denies`; `allow with pathPattern and no query paths does not match`.
  - `allow pattern needs every path to match`; `deny pattern matches if any path matches`; deny pattern is case-insensitive (`SECRETS/k` vs `secrets/**`), allow pattern is not.
  - `evaluate fails closed`: pass a rule whose `pathPattern` getter throws (`Object.defineProperty`) → `source:'error'`, `effect:'deny'`.
  - `validateGrant`: one test per `GrantError` plus accepted cases for global allow Read, agent allow Write with `src/**`, task allow Edit with future expiry, once allow Bash with 64-hex digest; `Bash` allow at `agent` → `scope_not_allowed_for_tool`; past `expiresAt` → `invalid_expiry`; `once` with `pathPattern` → `invalid_pattern`.
- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run server/permissions/engine.test.ts`.
- [ ] **Step 3: Implement `engine.ts`** to the signatures and matching rules above.
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** — `feat(server): add the pure permission engine and grant validation`.

---

### Task 3: Defaults and storage format

**Files:**
- Create: `server/permissions/defaults.ts`, `server/permissions/storage.ts`
- Test: `server/permissions/storage.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export function defaultRules(now: string): PermissionRule[]          // ids default-read, default-glob, default-grep, default-write, default-edit, default-bash, default-webfetch, default-websearch; scope 'global', createdBy 'default'
  export const PERMISSIONS_SCHEMA_VERSION = 1
  export function serializePermissions(rules: readonly PermissionRule[]): string   // JSON {schemaVersion, rules}
  export function parsePermissions(raw: unknown): PermissionRule[] | null           // null = corrupt; strict, every field checked
  ```

- [ ] **Step 1: Write `storage.test.ts` (failing):**
  - `defaultRules`: eight rules; Read/Glob/Grep allow, Write/Edit ask, Bash/WebFetch/WebSearch deny; all global and active at `now`.
  - round trip: `parsePermissions(JSON.parse(serializePermissions(rules)))` deep-equals `rules` (include a task rule, an expired one and a used once-rule).
  - `parsePermissions` returns `null` for: not an object, wrong `schemaVersion`, `rules` not an array, a rule with an unknown scope, an unknown effect, a non-string `tool`, a `once` rule without a digest, a duplicate id, an unparseable `createdAt`, an extra unknown field on a rule.
- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run server/permissions/storage.test.ts`.
- [ ] **Step 3: Implement both files.** Validate the same scope/id/digest consistency as `validateGrant` so a hand-edited file cannot hold a rule the API would refuse; unknown extra fields make the whole file `null`.
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** — `feat(server): add permission defaults and a strict storage format`.

---

### Task 4: The permission store

**Files:**
- Create: `server/permissions/store.ts`
- Test: `server/permissions/store.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` from `server/store.ts`; `errorCode`/`ErrorCode` from `server/errorCodes.ts`; `Logger` from `server/log.ts`; `createId` from `src/layout/operations.ts` (prefix `'perm'`); Tasks 1 to 3.
- Produces:
  ```ts
  export const PERMISSIONS_FILE = 'permissions.json', PERMISSIONS_BACKUP_FILE = 'permissions.backup.json'
  export type PermissionChange = { kind: 'granted' | 'revoked' | 'used' | 'ended' | 'expired'; rule: PermissionRule }
  export type PermissionStoreOptions = { dataDir: string; now: () => string; log: Logger; onChange?: (c: PermissionChange) => void; writeFile?: (path: string, text: string) => void; limits?: { maxActive: number; maxHistory: number } }  // defaults 500 and 1000
  export type GrantResult = { ok: true; rule: PermissionRule } | { ok: false; error: GrantError | 'limit' }
  export type RevokeResult = { ok: true; rule: PermissionRule } | { ok: false; error: 'not_found' | 'inactive' }
  export type PermissionStore = {
    readonly rules: readonly PermissionRule[]
    readonly load: { seeded: boolean; problem: 'corrupt' | 'unsupported-version' | null; preserved: 'backup-created' | 'backup-exists' | null }
    readonly saveError: ErrorCode | null
    readonly filePath: string
    grant(input: GrantInput): GrantResult
    revoke(id: string): RevokeResult
    revokeForAgent(agentId: string): PermissionRule[]   // active agent/task/once rules of that agent; never global
    consumeOnce(id: string): boolean                    // true exactly once, only for an active once rule
    endTask(taskId: string): PermissionRule[]           // marks active task/once rules of that task ended
    sweep(): PermissionRule[]                           // reports each rule that has newly expired, once, via onChange 'expired'
    evaluate(query: PermissionQuery): PermissionDecision  // engine over current rules; never throws, errors give deny
  }
  export function openPermissionStore(opts: PermissionStoreOptions): PermissionStore
  ```

Behaviour: no file → seed `defaultRules`, save, `load.seeded = true`. Corrupt or newer `schemaVersion` → in-memory defaults only, `load.problem` set, existing file copied to the backup path if no backup exists (as `server/store.ts` does), and the damaged file is left untouched until the next change. A non-ENOENT read error throws. Every mutation changes memory first and saves after; a failed save sets `saveError` but the in-memory change (including a revoke) still stands. `grant` returns `limit` when active rules reach `maxActive`. After each mutation, inactive rules beyond `maxHistory` are dropped oldest-first; default and active rules are never dropped.

- [ ] **Step 1: Write `store.test.ts` (failing)** (temp dir per test, fixed `now`, a mutable clock where time matters):
  - `seeds defaults on first start and writes the file`; file parses with `parsePermissions`.
  - `restart keeps grants`: grant, reopen, rule present.
  - `grant validates`: invalid input returns the engine's error and writes nothing; `limit` at `maxActive: 2`.
  - `revoke takes effect on the next evaluate`: allow Write at agent scope → `evaluate` allow; `revoke` → ask (global default); second `revoke` → `inactive`; unknown id → `not_found`.
  - `revokeForAgent` revokes agent, task and once rules for that agent only, not global, not other agents.
  - `consumeOnce`: true then false; false after revoke; false for a non-once or unknown id; two calls in one tick give exactly one `true`.
  - `endTask` ends task and once rules for that task only; `evaluate` then ignores them.
  - `sweep` reports an expired rule once (advance the clock past `expiresAt`; second `sweep` returns `[]`); `onChange` receives `granted`, `revoked`, `used`, `ended`, `expired` with the rule.
  - `corrupt file`: garbage JSON → `load.problem === 'corrupt'`, backup created, `evaluate` for `Write` with no matching rule is `ask` (defaults), and **no rule other than the eight defaults exists**; a file with `schemaVersion: 99` → `unsupported-version`.
  - `a rule the corrupt file held does not survive`: a file listing an `allow Bash global` plus a bad field loads as defaults, so Bash evaluates to deny.
  - `save failure keeps the change`: a `writeFile` that throws `EACCES` → `saveError === 'EACCES'`, revoke still effective in memory.
  - `history is pruned`: with `maxHistory: 3`, grant and consume five once rules; only the newest three inactive remain; defaults and active rules intact.
  - `evaluate never throws`: corrupt a rule in memory via a cast so the engine throws → `source:'error'`.
- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run server/permissions/store.test.ts`.
- [ ] **Step 3: Implement `store.ts`** to the behaviour above, following the structure of `openWorkforceStore` (`server/store.ts:58-136`).
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Commit** — `feat(server): add the permission store with atomic grants, revokes and one-time use`.

---

### Task 5: Audit actions and fields, final verification, report, PR

**Files:**
- Modify: `server/audit.ts` (the `AuditAction` union, `AuditInput`, `emit`)
- Test: `server/audit.test.ts` (add cases)
- Create: `docs/milestone-3b4-stage-a-report.md`

**Interfaces:**
- Produces: `AuditAction` gains `'permission.granted' | 'permission.denied' | 'permission.revoked' | 'permission.expired' | 'permission.used'`; `AuditInput` and `AuditRecord` gain optional `digest`, `actionHash`, `ruleId` (each passed through `field()`, i.e. scrubbed and capped at `AUDIT_FIELD_MAX`). Nothing emits them yet.

- [ ] **Step 1: Add failing tests to `server/audit.test.ts`:** a `permission.revoked` record with `ruleId`, `digest` and `actionHash` is written with those fields; an over-long `actionHash` is truncated to `AUDIT_FIELD_MAX`; a control character in `ruleId` is scrubbed; existing records without the new fields are unchanged (no `undefined` keys in the JSON line).
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run server/audit.test.ts`.
- [ ] **Step 3: Implement** the union and field additions in `server/audit.ts`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Full verification** — `npm test` (expect all previous 979 tests plus the new ones passing), `npx tsc -b` (no output), `npm run build`, `npm run check:secrets` ("No secrets found"). Confirm `git diff --stat main` touches only `server/permissions/**`, `server/audit.ts`, `server/audit.test.ts` and the report.
- [ ] **Step 6: Write `docs/milestone-3b4-stage-a-report.md`:** changed files, test counts from the real run, security implications (fail-closed evaluation, deny-by-pattern without paths, case/Unicode handling, single-use consume, corrupt-file behaviour, rules not yet enforced anywhere), and remaining blockers for stage B (gate integration, `ALLOWED_TOOLS` ceiling, scope on the approval endpoint, queueing, emitting the audit actions). Say plainly that nothing is enforced at runtime yet.
- [ ] **Step 7: Commit and PR** — commit `feat(server): add permission audit fields; report stage A`, push, and open a PR to `main` titled `feat(server): milestone 3B.4 stage A — permission engine` with the body ending `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Per the project rule, stop there; the PR is merged by the user.

---

## Self-Review

- **Spec coverage:** 4.1 model, evaluation, defaults, persistence, ceiling (ceiling is stage B, noted) → Tasks 1 to 4; 4.3 grant restrictions → Task 2 `validateGrant`; audit fields of 4.5 → Task 5; test-matrix rows for global, agent, task, once, deny, expiry, revoke, corrupt file → Tasks 2 and 4. Rows needing the gate (stale digest, concurrency, cancel-while-waiting, workspace escape, unauthorized tool, browser auth, SSE) belong to stages B to G.
- **Deviations from the spec, builder's call:** `endsWithTask` is derived from scope (task and once rules end with their task) instead of being a stored field; `revokeForAgent`, `sweep` and history pruning are added because the spec's revoke-all, expiry audit and bounded history need them.
- **Type consistency:** `PermissionRule`, `GrantInput`, `PermissionQuery`, `PermissionDecision` and `GrantError` are defined once in Task 1 and used unchanged in Tasks 2 to 4.
- **Proportion:** the plan is about twice the spec's length, with signatures and test assertions rather than bodies.
