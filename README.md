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

## Open with Claude Code `/vo`

1. Open a terminal and enter this project folder.
2. Start Claude Code from the project root: `claude`.
3. Type `/vo`.

The project command is defined in `.claude/commands/vo.md`. It invokes `scripts/vo.sh`, which starts the Vite server only if the local URL is not already responding, then opens the browser on macOS or Linux desktop environments.

You can also run `./scripts/vo.sh` directly without Claude Code.

## Current prototype

- Realistic-inspired 3D office shell with glass-style partitions, desks, monitors, chairs, plants, and team labels
- Orbit, zoom, and pan camera controls
- Toggle between 3D overview and top-down floor-plan view
- Basic Save layout action (currently saves view metadata locally; editable geometry and full layout serialization are planned next)
- Local-only development server bound to 127.0.0.1

## Next milestone

Implement editable room geometry and furniture placement, then persist the complete layout in local storage. AI agent runtimes and task orchestration will be added after the office editor is stable.
