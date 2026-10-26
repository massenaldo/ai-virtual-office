# Milestone 2 — Realistic Office Builder: Tasks

**Spec:** [`plan.md`](plan.md) (Milestone 2 brief). This file is my working task list for that spec.
**Status:** Approved 2026-10-25. All open questions answered (see the end); the user may raise concerns later.

## What this milestone is

A visual upgrade of the existing 3D office, not a rewrite. The office should look like a real, premium modern tech office: warm wood desks, graphite metal, glass partitions, realistic chairs and monitors, natural daylight. The dark app UI, the layout editor, saving, undo/redo and `/vo` must all keep working. The scope is visual realism only: no AI agents, backend, auth, multiplayer or video studio.

## Current state (from inspecting the code, 2026-10-25)

- **Build and tests:** `npm run build` passes (only a chunk-size warning, already present before this milestone). `npm test` passes, 84/84.
- **Scene code:** `src/scene/`
  - `OfficeScene.tsx`: lights, floor, cameras
  - `RoomMesh.tsx`: room floor slab, 2 side walls, glass back wall, ceiling slab, label
  - `FurnitureItem.tsx` and `models.tsx`: 5 procedural models built from primitives
  - `FootprintOutline.tsx`, `ResizeHandles.tsx`, `useFloorDrag.ts`: editor feedback and interaction
- **Layout data:** `src/layout/`. The scene renders `OfficeLayout` (schema v1, key `ai-virtual-office:layout:v1`). Furniture types are desk, chair, monitor, plant and meeting-table, and storage only accepts known types.
- **Remote asset:** `<Environment preset="apartment">` downloads `lebombo_1k.hdr` from `raw.githack.com` at runtime. This conflicts with plan.md §7 (self-hosted).
- **Shadows:** every model mesh and every wall casts shadows (13 `castShadow` uses), with a 2048² shadow map.
- **Visibility:** each room has a solid ceiling slab plus three walls with an open front side, so the ceiling hides the room interior from above.
- **Floor plan:** an orthographic top-down camera with furniture drawn as flat coloured tiles. Walls and ceilings are hidden.

## How I'll work

- **One stage = one branch = one PR into `main`**, e.g. `feat/office-visuals-stage-a`. No stacked PRs. You merge, then I delete the merged branches.
- **Before/after screenshots from the same fixed camera angles** go in every PR (3D overview, a close-up, floor plan), because visual quality can't be checked by unit tests.
- **Each stage ends with the editor regression checklist below,** run in the browser, plus `npm test` and `npm run build`.
- **Decisions follow your direction over plan.md §10.** plan.md says "do not stop after producing a plan", but you asked to discuss first and review each stage, so I'll stop for review after each PR.

## Decisions (proposed by me, agreed 2026-10-25)

1. **Lighting without downloads:** replace the remote HDR with lighting built in code (drei `Environment` with `Lightformer` panels, plus sun and soft fill lights). No network requests and no new dependency.
2. **No new rendering dependencies:** no post-processing library. Soft shadows come from tuned shadow maps plus the existing `ContactShadows`, and "ambient occlusion" is faked cheaply (darker contact areas, baked gradients) rather than a real-time AO pass.
3. **Floor material comes from the room's department** (for example carpet for offices, concrete for the server room), so the saved-layout format doesn't change.
4. **New furniture types extend the schema in a backward-compatible way.** Storage cabinet, shelf and meeting chair are added to the furniture list. Old saves still load and the schema stays v1. Keyboard, mouse and desk accessories become part of the desk model, not separate items.
5. **Shared geometry and materials:** one shared materials module, and each furniture model's parts are merged into a few meshes (using three.js's own utilities, nothing new to install). Only larger objects cast shadows; small details don't.
6. **Changing the default office only affects Reset.** Your saved layout keeps its own rooms and furniture; new furniture only appears in the default after Reset layout.

## Stage A: Lighting, materials, floor, walls, structure

- [x] Lighting built in code instead of the remote HDR; balanced daylight plus soft interior fill; tuned tone mapping and exposure
- [x] Shared material library (oak, graphite metal, warm-white wall paint, glass, concrete, carpet, epoxy); walnut comes with the Stage B furniture
- [x] Office floor finish plus per-room floors (by department), with clear room boundaries
- [x] Walls with real thickness, clean corners and baseboards; ceilings removed (cutaway view, Q1)
- [x] Clean background and a default overview camera that shows the whole office (fitted to the canvas, including edit mode)
- [x] Floor plan stays clear: readable room colours, boundaries and labels
- [x] PR with before/after screenshots
- Also fixed in Stage A: one room label could render empty (labels now live in one DOM layer); open-floor furniture floated 8 cm above the floor.
- Found, not fixed: `src/styles.css` loads the DM Sans and Manrope fonts from Google Fonts at runtime (needs the user's OK to download and self-host the font files). Fixed in Stage D.

## Stage B: Furniture models

- [x] Desk: proper top thickness, graphite frame, optional drawer unit or cable tray, keyboard and mouse
- [x] Monitor: slim dark bezel, screen surface, stand and base
- [x] Ergonomic chair: seat, backrest, armrests, gas lift, 5-star base with wheels; low polygon count
- [x] Meeting table refresh, plus **new** meeting chair, storage cabinet and shelf (schema, palette, catalog footprints, floor-plan tiles, tests)
- [x] Footprints in `catalog.ts` match the new models, so selection, overlap checks and snapping stay accurate
- [x] PR with before/after screenshots
- Plants were only shrunk to fit their footprint (the old foliage was 0.96 m wide); the leafy redesign is in Stage C.

## Stage C: Glass, plants, details

- [x] Glass partitions with slim graphite frames for meeting rooms and offices; walls and glass never catch clicks
- [x] Plants with leaf clusters in a proper planter, in a couple of sizes
- [x] A few restrained details (wall art, a whiteboard in meeting rooms) that never block editing
- [x] Default office updated with the new furniture (meeting chairs, storage); move the default meeting table fully inside the meeting room (it currently sticks through the room's east wall)
- [x] PR with before/after screenshots

## Stage D: Optimize and verify

- [x] Count draw calls and meshes before and after; limit shadow casters; check frame rate while dragging
- [x] Full editor regression checklist in 3D and floor plan
- [x] Production build (`vite preview`) checked in the browser; `/vo` end to end
- [x] Self-host the DM Sans / Manrope fonts only if necessary (user, 2026-10-25: "include it in a later stage if necessary")
- [x] README updated (visuals, assets and licences if any, limitations)
- [x] Final report per plan.md §10
- Results: 1305 → 803 draw calls per frame in the 3D overview (room shells merged), and 60 → 0 frames per second while idle (render on demand). Shadow casters were already limited in Stage B (only walls and larger furniture), so they needed no change. Fonts self-hosted (user, 2026-10-26). Full report: [`docs/milestone-2-report.md`](docs/milestone-2-report.md).

## Editor regression checklist (every stage)

- Select, move, resize and rename rooms
- Select, move, rotate, duplicate, add and delete furniture
- Undo and redo
- Save → reload restores the layout
- Reset layout, with its confirmation
- 3D and floor plan stay in sync
- Grid and snap
- Keyboard shortcuts
- Selection outlines and labels stay readable over the new materials
- No console errors

## Open questions (all answered)

- **Q1: Ceilings — answered:** cutaway. No ceilings, so every room is visible from above.
- **Q1b: Front walls — answered:** no doors. Each room's front side stays open, so the interior is visible from any angle. This overrides plan.md §3 "doors where they make sense".
- **Q2: Reference look — answered:** no reference; use my design judgment. My call for the look:
  - **Floors:** light polished concrete in open areas; warm-grey carpet tiles in offices and team rooms; light oak in the meeting room and executive office; dark epoxy in the server room.
  - **Walls:** warm-white walls with thin graphite baseboards; frameless or slim-framed glass toward circulation areas.
  - **Furniture:** natural oak desktops on matte graphite frames; charcoal mesh chairs; black monitors with soft blue-grey screen glow; walnut for the executive office and meeting table.
  - **Lighting:** soft late-morning daylight from one side with gentle, not crushed, shadows; warm interior fill.
  - **Colour:** department colours become subtle accents (floor inlay or label tint) instead of fully coloured rooms, to keep the palette restrained.
- **Q3: Decisions 1–6 — answered:** agreed.
