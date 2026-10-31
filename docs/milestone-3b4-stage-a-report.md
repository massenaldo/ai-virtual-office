# Milestone 3B.4 stage A: permission engine — report

Date: 2026-11-01. Plan: `docs/superpowers/plans/2026-11-01-milestone-3b4-stage-a-permission-engine.md`. Spec: `docs/superpowers/specs/2026-11-01-milestone-3b4-permissions-design.md`.

**Nothing is enforced at runtime yet.** The engine and store exist and are tested, but no part of the running server calls them. The tool gate, task manager, routes, config and frontend are unchanged. The Claude Agent SDK is not installed and no real Claude execution exists.

## Verification (real runs on this branch)

| Check | Result |
|---|---|
| `npm test` | 74 files, 1063 tests pass (979 before; +84 new) |
| `npx tsc -b` | clean |
| `npm run build` | built (the existing chunk-size warning only) |
| `npm run check:secrets` | no secrets found |

New tests: `pathPattern` 23, `engine` 19, `storage` 17, `store` 18, `audit` +7.

## Changed files

- New: `server/permissions/{types,pathPattern,engine,defaults,storage,store}.ts` and the matching `*.test.ts` for the first, third, fourth and sixth modules.
- Modified: `server/audit.ts` (five `permission.*` actions; `digest`, `actionHash` and `ruleId` fields, capped at 64 characters, placed after `reason`; old records are byte-for-byte unchanged), `server/audit.test.ts`.

## Security implications

- **Fail closed.** `evaluate` returns deny with source `error` on any exception; the store's `evaluate` wraps it again.
- **Deny wins, defaults match today.** Reads allow, writes ask, Bash and network tools deny. A default deny blocks a once-grant until a person revokes it (by spec).
- **Path rules.** A deny with a pattern matches a call that names no path (a workspace-wide Grep or Glob), matches case-insensitively (macOS), compares Unicode in NFC, and `secrets/**` also covers the folder `secrets` itself. An allow with a pattern needs every path to fit, case-sensitively. Patterns reject `..`, absolute, `~`, backslash, brackets, braces, empty segments and anything over 200 characters; the matcher is memoised and has no regular expressions.
- **Single use.** `consumeOnce` is synchronous: true once, false for a second call, after a revoke, for non-once rules and unknown ids.
- **Revoke survives a failed save.** Memory changes first.
- **Damaged file.** A corrupt or newer-version `permissions.json` loads as the eight defaults only, is backed up, and is left untouched until the next change. Parsing is strict: one bad rule, an unknown field, a duplicate id or an `allow` on an execute or network tool outside `once` makes the whole file corrupt.
- **Audit.** Control characters in the new fields are JSON-escaped like every existing field, so a record stays one line.

## Rulings made during implementation

1. A trailing `**` matches at least one segment (`src/**` is the contents of `src`, not `src`). To keep that from letting a deny be sidestepped, deny rules also test `<path>/_`.
2. `parsePermissions` also rejects `allow` on execute or network tools outside `once`; the plan only implied it.
3. `maxActive` counts non-default rules (the eight defaults would otherwise make the limit untestable).
4. The audit test asserts one record stays one line rather than that control characters are removed; `scrub` has never removed them.

## Review

Self-review by the author only (no independent reviewer was run). For security-critical code I recommend an independent review of `engine.ts`, `pathPattern.ts` and `store.ts` before stage B builds on them.

## Remaining blockers for stage B

Gate and manager integration (call `evaluate` in `approveTool` and again at use time, consume once-grants before `perform`); the `ALLOWED_TOOLS` ceiling; a scope on the approval endpoint; per-task queueing of concurrent requests; emitting the `permission.*` audit actions with the digest and action hash; wiring the store into `createApp`.
