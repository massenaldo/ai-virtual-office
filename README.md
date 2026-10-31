# AI Virtual Office — v0.1.0

A self-hosted, browser-based 3D office prototype built with React, TypeScript, Vite, Three.js, React Three Fiber, and Drei.

## Requirements

- Node.js 20.19+ or 22.12+ recommended
- npm
- Claude Code (optional; only needed for the `/vo` shortcut)

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173.

### Run with the local backend (optional)

| Command | What it starts |
|---|---|
| `npm run dev` | Frontend only, with the browser mock (default; `/vo` uses this) |
| `npm run server` | The backend alone, on `127.0.0.1:8787` |
| `npm run dev:full` | The backend and the frontend, with the UI reaching it through the same-origin dev proxy (no setup, no token to copy) |
| `npm run server:build` then `npm run server:start` | The production backend bundle (`dist-server/index.js`, only `node:` imports) |

To use the backend with a separately started frontend, run `npm run server`, then `VITE_WORKFORCE_API_URL=/ npm run dev`. The value `/` means "this page's own origin": the Vite dev server adds the API token on the server side and forwards `/api/*` to the backend (see "API token" below). An invalid value shows "Not configured" instead of falling back to the browser mock, and a direct `http://127.0.0.1:8787` is accepted but gets "Not authorized", because the browser has no token.

## Open with Claude Code `/vo`

1. Open a terminal and enter this project folder.
2. Start Claude Code from the project root: `claude`.
3. Type `/vo`.

The project command is defined in `.claude/commands/vo.md`. It invokes `scripts/vo.sh`, which starts the Vite server only if the local URL is not already responding, then opens the browser on macOS or Linux desktop environments.

`/vo` opens the office at `http://localhost:5173/sessionID=<ID>`, where `<ID>` is the Claude Code session's ID, and shows that link as a note in the reply. The ID only appears in the link; the app ignores it.

**Auto-stop:** a server started by `/vo` stops immediately when the last browser page is closed, and removes `.vo-server.pid`. A page reload also closes the page's connection, so it stops the server too; run `/vo` again. Anything you haven't saved is discarded, and the next start loads your last saved layout. A server you start yourself with `npm run dev` is never stopped this way.

You can also run `./scripts/vo.sh [sessionID]` directly without Claude Code.

## Features

- **Realistic 3D office**, all built in code with no downloaded models or textures:
  - Soft daylight and interior fill lighting generated in the browser (no HDR download), with soft shadows
  - Floor finishes by department: polished concrete in open areas, carpet tiles in team rooms, light oak in the meeting room and executive office, dark epoxy in the server room
  - Cutaway rooms (no ceilings, open front) with warm-white walls, graphite baseboards, and slim-framed glass partitions
  - Oak desks on graphite frames with keyboard and mouse, ergonomic chairs, slim monitors, a walnut meeting table with meeting chairs, storage cabinets, shelves, and leafy plants in two sizes
  - A few restrained wall details: framed art in the executive office, a whiteboard in the meeting room
- The office stands on one storey of a tower: a warm-concrete floor slab with a visible edge
- Team labels that stay readable in 3D and floor plan
- Orbit, zoom, and pan camera controls; a true top-down floor plan (orthographic, pan and zoom only)
- **Layout editor** (click **Edit layout**):
  - Select rooms and furniture in the scene or in the left-hand list; edit them in the properties panel
  - Drag rooms and furniture on the floor; resize rooms with edge handles in floor plan
  - Grid with snap-to-grid (0.25 m) in floor plan
  - Add rooms from templates and furniture from the palette; rotate (90°), duplicate, delete
  - Rotate a room in 90° steps: its walls, glass, details and furniture turn with it around the room's centre
  - Overlapping or out-of-bounds placement is outlined in red and listed in the properties panel (a warning, not a block)
  - Undo/redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z), Delete/Backspace, and Esc to clear the selection or cancel a drag
- **Saving:** the complete layout (rooms, furniture, office settings) is stored in the browser's `localStorage` under `ai-virtual-office:layout:v1` and restored on the next start. The status shows Saved, Unsaved changes, or Save failed. You're asked before leaving edit mode or closing the tab with unsaved changes
- **AI agent workforce** (click **AI Agents** in the sidebar). **Tasks are simulated in the browser: nothing calls Claude or any other AI, makes network requests or runs processes.** The panel shows a **Mock mode** badge, demo agents are labelled **Demo**, and simulated task events are labelled **Simulated**.
  - Six demo agents (Project Management, Tech Lead, Backend, Frontend, QA, DevOps) seated at default desks, added once on first start; **Restore demo agents** brings back any you removed
  - Filter agents by department and status; create, edit and remove agents (removing one with task history asks first)
  - Assign one agent per desk from a picker grouped by room, or unassign
  - Start a simulated task: the agent goes Thinking, then Working, then Completed (about 6 seconds), with an activity timeline. **Cancel task**, and demo buttons for **Simulate waiting** / **Resume** / **Simulate error**
  - In the office: a status marker over each assigned desk (3D and floor plan); the selected agent's desk is outlined and **Focus desk** moves the camera to it; with the panel open, click a desk to open its agent, or click a free desk to assign one
  - Layout editing and the agents panel are separate modes; opening the panel with unsaved layout changes asks you to save or discard first
- Local-only development server bound to 127.0.0.1

## Backend (milestone 3B.1)

A small Node server (`server/`, no framework, no runtime dependencies) owns agents, tasks and activity, runs tasks through a runtime provider, and pushes updates to the browser. **It runs the mock runtime only. The Claude Agent SDK is not installed or integrated, and no real agent execution exists.** `RUNTIME=claude` starts a provider that reports "Claude Agent SDK not installed" and refuses tasks.

**Architecture.** The browser's `WorkforceController` has two implementations behind `useWorkforce`: the local one (browser mock) and `RemoteWorkforceController` (REST for commands, server-sent events for updates, snapshot plus replay recovery, reconnect with backoff). The domain model in `src/workforce/` is shared by both sides.

**Environment variables** (copy `.env.example` to `.env`; real environment variables win):

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where it listens. Loopback only |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Exact browser origins allowed; `none` allows no browser |
| `DATA_DIR` | `./data` | Where `workforce.json` and `audit.log` live |
| `WORKSPACE_ROOT`, `WORKSPACES` | unset | Absolute folder and named workspaces (`id:relative/path`) |
| `RUNTIME` | `mock` | `mock` or `claude` (unavailable) |
| `TASK_TIMEOUT_MS`, `CANCEL_GRACE_MS`, `APPROVAL_TIMEOUT_MS` | 600000, 5000, 300000 | Task, cancel and approval limits |
| `ALLOWED_TOOLS` | `Read,Glob,Grep,Write,Edit` | Tool allowlist; write, execute and network tools always need approval |
| `MAX_MESSAGE_BYTES`, `MAX_TASK_OUTPUT_BYTES`, `EVENT_BUFFER_SIZE`, `AUDIT_LOG_MAX_BYTES` | 32768, 262144, 500, 5242880 | Output and log limits |
| `ANTHROPIC_API_KEY` | unset | Server only, unused until the Claude provider exists. Never a frontend variable |
| `API_TOKEN` | generated at each start | Token every API request must send as `Authorization: Bearer <token>`. At least 32 characters, no spaces. Server only: never a `VITE_` variable (refused at start) |
| `VITE_WORKFORCE_API_URL` | empty | Frontend only. Empty = browser mock; `/` = same-origin backend through the dev proxy |

**API** (JSON; every route except `GET /api/health` needs `Authorization: Bearer <token>`; every POST/PUT/PATCH/DELETE needs `Content-Type: application/json`, even without a body):

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Runtime, availability, persistence and audit status. The only route that needs no token |
| `GET /api/state` | Full state and `lastEventId` |
| `GET /api/workspaces` | Workspace ids (never paths) |
| `GET /api/events` | Server-sent events; resume with `Last-Event-ID` or `?lastEventId=` |
| `POST /api/agents`, `PATCH` / `DELETE /api/agents/:id` | Create, update, remove an agent |
| `PUT /api/agents/:id/desk` | Assign or clear a desk |
| `POST /api/agents/:id/tasks` | Start a task (`title`, `description`, optional `workspaceId`) |
| `POST /api/tasks/:id/cancel`, `POST /api/tasks/:id/approval` | Cancel; approve or deny (`approvalId`, `decision`) |
| `POST /api/demo/...` | Mock-only demo controls: request approval, force error, restore demo agents |

**Events.** Ids are `<boot>:<seq>`. Types: `task.queued`, `task.started`, `agent.status_changed`, `agent.message`, `task.progress`, `task.waiting_for_approval`, `task.completed`, `task.failed`, `task.cancelled`, `state.changed`, `state.reset`. Each change event carries a patch of the records it touched. `state.reset` means the client's id is too old, from another server run, or ahead of the server: reload `GET /api/state`.

**Security boundaries.** These are policy checks, not an OS sandbox.
- Bound to loopback; `Host` and `Origin` allowlists (421 / 403); JSON-only mutations (415); CORS only for allowed origins; security headers.
- API token: every route except health, including the event stream and requests with no `Origin`, needs the bearer token (401 otherwise). Compared in constant time; never accepted in a URL; never logged, audited, returned or compiled into the bundle (`check:secrets` looks for it).
- Workspaces are named by id; the browser never sends a path. Paths are checked against the workspace real path (symlinks resolved, `..` refused, a path through a regular file refused) and the root stored at startup. Write and Edit always need a workspace; without one the mock demo falls back to the simulated run's own approval.
- Tool gate: a runtime can only use a tool through `ctx.tools.use(request, perform)`. The input is a frozen copy, the approval is for that copy, and a digest of task, workspace, tool and input plus the path and workspace are re-checked right before `perform` runs (otherwise `stale_approval`, audited as `tool.stale`). A Write or Edit approval shows the whole content or change, or nothing is asked (a change too long to show is refused until a richer review screen exists). Only the mock may raise an approval of its own.
- Tool policy: unknown tools denied; read tools allowed inside a workspace; write, execute and network tools always need a human approval whose summary shows the whole action (otherwise denied); no bypass mode.
- Secrets are redacted from logs, state, events and the audit log; workspace paths are hidden in runtime output; `npm run check:secrets` scans the built bundles.
- `data/audit.log` (JSONL, mode 0600, rotated at 5 MB) records lifecycle, tool and rejected-request events, never bodies.

**API token.** Set `API_TOKEN` (32+ characters) or let the server generate a fresh 256-bit token at each start, written to `data/api-token` (mode 0600, git-ignored with `data/`). The audit log records only `auth=configured` or `auth=generated`.
- *Browser:* the dev proxy (`scripts/apiProxy.ts`) runs in Node. For requests the browser marks `Sec-Fetch-Site: same-origin` it replaces any `Authorization` and `Cookie` header with the token and forwards `/api/*`; everything else gets 403. It reads the token on every request, so a backend restart is picked up. It only exists where Vite runs (`dev:full`, `dev` with `VITE_WORKFORCE_API_URL=/`), and any local program that can reach port 5173 can send `Sec-Fetch-Site: same-origin` itself (the header is only trustworthy for browsers) and gets an authenticated path. So while the proxy runs, the token protects the backend from programs that talk to it directly and from web pages, not from other local programs on this machine. A session cookie after a one-time pairing is the real fix and is not built. The Vite dev server also refuses to serve the `data/` folder (token, audit log, state). `vite preview` and a VPS need the backend to serve the UI, or a session-cookie flow (not built).
- *One server per `DATA_DIR`:* the server takes `data/server.lock` and a second server on the same folder refuses to start (a lock left by a crashed process is replaced). The token is wrapped so it cannot be printed.
- *Long term:* [`docs/browser-auth.md`](docs/browser-auth.md) records the decision (session cookie after a one-time pairing, not built) and states that `Sec-Fetch-Site` is not authentication against other local programs.
- *Rotation:* restart the server (generated), or change `API_TOKEN` and restart. A configured token is never written to disk.
- *Other clients:* `curl -H "Authorization: Bearer $(cat data/api-token)" http://127.0.0.1:8787/api/state`.
- `/vo` and `npm run dev` stay browser-only and need no token.

**Sandbox.** There is none yet: [`docs/sandbox-architecture.md`](docs/sandbox-architecture.md) is a design only (Docker, one workspace mounted, no network, resource limits) with its blockers. No isolation is active.

**Persistence.** `data/workforce.json` (atomic writes, mode 0600). An unreadable file is backed up before a fresh start. A task running at shutdown is marked failed with "Interrupted by a server restart". The event buffer is in memory, so a restart makes every old event id a `state.reset`.

## Layout data

The scene renders a typed, versioned `OfficeLayout` (`src/layout/types.ts`). It is the single source of truth.

- World units are metres. A room or furniture item's `x`/`z` is the **centre of its footprint** on the floor plane; `width` runs along X and `depth` along Z. Vertical values (`wallHeight`, model heights) are kept separate.
- Rooms are 2–12 m wide and 2–12 m deep and stay inside the 25 × 20 m office.
- Saved data that can't be read (damaged, or from a newer version) is never overwritten silently: the app shows the default layout and copies the old value to `ai-virtual-office:layout:v1:backup` before the next save.
- **Reset layout** restores the default office after a confirmation and can be undone.

## Agent data

Agents, tasks and recent activity are typed, versioned data in `src/workforce/` (`types.ts`), kept apart from the layout.

- **Storage:** `localStorage` key `ai-virtual-office:workforce:v1`, saved automatically on every change. Agent changes are not part of the layout's undo history and never touch the layout key.
- **Validation:** loading checks every record and every reference (task ↔ agent, activity ↔ agent and task, one agent per desk, one active task per agent). Data that can't be read is copied to `ai-virtual-office:workforce:v1:backup`, a notice is shown, and the panel starts empty; nothing is overwritten without a backup.
- **History:** the newest 300 activity events are kept; tasks are kept.
- **Desks:** an agent refers to a desk by its furniture ID. If that desk is no longer in the layout (deleted, or a different layout), the agent keeps the reference and shows **Workstation unavailable** until you pick another desk.
- **Reload:** a task that was running when the page closed is marked failed with "Interrupted by page reload (simulated run)".
- **Runtime boundary:** a `RuntimeProvider` interface (`src/workforce/runtime/types.ts`) separates the app from whatever executes a task. `MockRuntimeProvider` is the browser-timer simulation used today. `ClaudeRuntimeProvider` is a placeholder that only reports "Not available: requires a server-side runtime." A real Claude runtime must run on a server: the browser must never hold Anthropic credentials or API keys, or get shell or process access.

## Development

```bash
npm test        # unit tests (Vitest) for the layout model, storage, history, editor logic, and the agent workforce (operations, storage, mock runtime, controller, view helpers)
npm run build   # type-check and production build
npm run preview # serve the production build at http://127.0.0.1:4173
```

Add `?stats` to the URL (for example http://localhost:5173/?stats) to show a small render read-out over the 3D view: frames per second, CPU time per frame, draw calls and triangles. The 3D view only redraws when something changes, so it reads "idle" while nothing moves.

## Assets and licences

- All 3D geometry, materials and floor textures are generated in code. The project contains no external models, textures or HDR files.
- Fonts: DM Sans and Manrope are bundled through the `@fontsource-variable/dm-sans` and `@fontsource-variable/manrope` packages (SIL Open Font License 1.1). Nothing is loaded from Google Fonts or any other remote host at runtime.

## Known limitations

- A desk, its chair and its monitor are separate items, so they move independently.
- Resize handles are available in floor plan only; in 3D, resize rooms from the properties panel.
- Layouts are stored per browser and per origin (for example `localhost:5173`); there is no export or sync yet.
- Rooms have no doors and no ceilings, by design: the cutaway keeps every room visible and editable from above.
- Furniture is not instanced: each item draws one mesh per material, so very large layouts (hundreds of items) cost more draw calls. Room shells are merged into one mesh per material.
- Lighting has no real-time ambient occlusion or post-processing; soft contact shadows stand in for it.
- `npm run build` warns that the main JavaScript chunk is larger than 500 kB (three.js); the app is not code-split yet.
- **Agents are a simulation**, in the browser and on the backend. No real Claude or Agent SDK execution exists yet; task results are canned text that says so.
- Backend mode has no login, one server process and one JSON file; it is meant for the local machine only.
- Agent data is per browser and per origin, like the layout: `localhost:5173` and `127.0.0.1:5173` keep separate agents.
- One task per agent at a time, with no queue. Finished tasks are never trimmed, only activity is.
- In the floor plan, a room's label can sit over the centre-row desks and hide the selected agent's desk outline; the marker's ring still shows which desk it is.
- Desk clicks in the office have no keyboard equivalent; the desk picker in the agent panel does the same thing.
- In 3D, clicking a wall or glass in front of a desk opens that desk's agent.
- If saved agent data is damaged a second time while an older backup exists, the older backup is kept and the new damaged data is not copied.

## Next milestone

Install and integrate the Claude Agent SDK behind `ClaudeAgentRuntimeProvider` (see the rules in `server/runtime/claudeAgent.ts`), with an OS-level sandbox before any real write or command execution.
